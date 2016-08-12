// Transforms a stream of TAP into a stream of result objects
// and string comments.  Emits "results" event with summary.
var Writable = require('stream').Writable
/* istanbul ignore if */
if (!Writable) {
  try {
    Writable = require('readable-stream').Writable
  } catch (er) {
    throw new Error('Please install "readable-stream" to use this module ' +
                    'with Node.js v0.8 and before')
  }
}

var yaml = require('js-yaml')
var util = require('util')
var assert = require('assert')

util.inherits(Parser, Writable)

module.exports = Parser

// every line outside of a yaml block is one of these things, or
// a comment, or garbage.
var lineTypes = {
  testPoint: /^(not )?ok(?: ([0-9]+))?(?:(?: -)?( .*))?\n$/,
  pragma: /^pragma ([+-])([a-z]+)\n$/,
  bailout: /^bail out!(.*)\n$/i,
  version: /^TAP version ([0-9]+)\n$/i,
  plan: /^([0-9]+)\.\.([0-9]+)(?:\s+(?:#\s*(.*)))?\n$/
}

var lineTypeNames = Object.keys(lineTypes)

function parseDirective (line) {
  line = line.trim()
  var time = line.match(/^time=((?:[1-9][0-9]*|0)(?:\.[0-9]+)?)(ms|s)$/i)
  if (time) {
    var n = +time[1]
    if (time[2] === 's') {
      // JS does weird things with floats.  Round it off a bit.
      n *= 1000000
      n = Math.round(n)
      n /= 1000
    }
    return [ 'time', n ]
  }

  var type = line.match(/^(todo|skip)\b/i)
  if (!type)
    return false

  return [ type[1].toLowerCase(), line.substr(type[1].length).trim() || true ]
}

function Result (parsed, count) {
  var ok = !parsed[1]
  var id = +(parsed[2] || count + 1)
  this.ok = ok
  this.id = id

  var rest = parsed[3] || ''
  var name
  rest = rest.replace(/([^\\]|^)((?:\\\\)*)#/g, '$1\n$2').split('\n')
  name = rest.shift()
  rest = rest.filter(function (r) { return r.trim() }).join('#')

  // now, let's see if there's a directive in there.
  var dir = parseDirective(rest.trim())
  if (!dir)
    name += rest ? '#' + rest : ''
  else
    this[dir[0]] = dir[1]

  if (name)
    this.name = name.trim()

  return this
}

function Parser (options, onComplete) {
  if (typeof options === 'function') {
    onComplete = options
    options = {}
  }

  if (!(this instanceof Parser))
    return new Parser(options, onComplete)

  options = options || {}
  if (onComplete)
    this.on('complete', onComplete)

  this.sawValidTap = false
  this.failures = []
  this.indent = options.indent || ''
  this.level = options.level || 0
  Writable.call(this)
  this.buffer = ''
  this.bailedOut = false
  this.planStart = -1
  this.planEnd = -1
  this.planComment = ''
  this.yamlish = ''
  this.yind = ''
  this.child = null
  this.current = null
  this.commentQueue = []
  this.buffered = options.buffered || null

  this.count = 0
  this.pass = 0
  this.fail = 0
  this.todo = 0
  this.skip = 0
  this.ok = true

  this.strict = false
  this.pragmas = { strict: false }

  this.postPlan = false
}

Parser.prototype.tapError = function (error) {
  this.ok = false
  this.fail ++
  if (typeof error === 'string') {
    error = {
      tapError: error
    }
  }
  this.failures.push(error)
}

Parser.prototype.parseTestPoint = function (testPoint) {
  // TODO dry the double-parse, pass the parsed data to Result ctor
  this.emitResult()

  var res = new Result(testPoint, this.count)
  if (this.planStart !== -1) {
    var lessThanStart = +res.id < this.planStart
    var greaterThanEnd = +res.id > this.planEnd
    if (lessThanStart || greaterThanEnd) {
      if (lessThanStart)
        res.tapError = 'id less than plan start'
      else
        res.tapError = 'id greater than plan end'
      this.tapError(res)
    }
  }

  this.sawValidTap = true
  if (res.id) {
    if (!this.first || res.id < this.first)
      this.first = res.id
    if (!this.last || res.id > this.last)
      this.last = res.id
  }

  // hold onto it, because we might get yamlish diagnostics
  this.current = res
}

// TODO: nonTap should get a buffer like comments, so that
// it can be ordered properly with the result data, yamlish, etc.
Parser.prototype.nonTap = function (data) {
  if (this.strict) {
    this.tapError({
      tapError: 'Non-TAP data encountered in strict mode',
      data: data
    })
  }
  this.emit('extra', data)
}

Parser.prototype.plan = function (start, end, comment, line) {
  // not allowed to have more than one plan
  if (this.planStart !== -1) {
    this.nonTap(line)
    return
  }

  // can't put a plan in a child or yaml block
  if (this.child || this.yind) {
    this.nonTap(line)
    return
  }

  this.sawValidTap = true
  this.emitResult()

  this.planStart = start
  this.planEnd = end
  var p = { start: start, end: end }
  if (comment)
    this.planComment = p.comment = comment

  // This means that the plan is coming at the END of all the tests
  // Plans MUST be either at the beginning or the very end.  We treat
  // plans like '1..0' the same, since they indicate that no tests
  // will be coming.
  if (this.count !== 0 || this.planEnd === 0)
    this.postPlan = true

  this.emit('plan', p)
}

Parser.prototype.resetYamlish = function () {
  this.yind = ''
  this.yamlish = ''
}

// that moment when you realize it's not what you thought it was
Parser.prototype.yamlGarbage = function (line) {
  var yamlGarbage = this.yind + '---\n' + this.yamlish + (line || '')
  this.emitResult()
  this.nonTap(yamlGarbage)
}

Parser.prototype.processYamlish = function () {
  var yamlish = this.yamlish
  this.resetYamlish()

  try {
    var diags = yaml.safeLoad(yamlish)
  } catch (er) {
    this.nonTap(yamlish)
    return
  }

  this.current.diag = diags
  this.emitResult()
}

Parser.prototype.write = function (chunk, encoding, cb) {
  if (typeof encoding === 'string' && encoding !== 'utf8')
    chunk = new Buffer(chunk, encoding)

  if (Buffer.isBuffer(chunk))
    chunk += ''

  if (typeof encoding === 'function') {
    cb = encoding
    encoding = null
  }

  if (this.bailedOut) {
    if (cb)
      process.nextTick(cb)
    return true
  }

  this.buffer += chunk
  do {
    var match = this.buffer.match(/^.*\r?\n/)
    if (!match || this.bailedOut)
      break

    this.buffer = this.buffer.substr(match[0].length)
    this._parse(match[0])
  } while (this.buffer.length)

  if (cb)
    process.nextTick(cb)
  return true
}

Parser.prototype.end = function (chunk, encoding, cb) {
  if (chunk) {
    if (typeof encoding === 'function') {
      cb = encoding
      encoding = null
    }
    this.write(chunk, encoding)
  }

  if (this.buffer)
    this.write('\n')

  // if we have yamlish, means we didn't finish with a ...
  if (this.yamlish)
    this.nonTap(this.yamlish)

  this.emitResult()

  var skipAll

  if (this.planEnd === 0 && this.planStart === 1) {
    skipAll = true
    if (this.count === 0) {
      this.ok = true
    } else {
      this.tapError('Plan of 1..0, but test points encountered')
    }
  } else if (this.planStart === -1) {
    this.tapError('no plan')
  } else if (this.ok && this.count !== (this.planEnd - this.planStart + 1)) {
    this.tapError('incorrect number of tests')
  }

  if (this.ok && !skipAll && this.first !== this.planStart) {
    this.tapError('first test id does not match plan start')
  }

  if (this.ok && !skipAll && this.last !== this.planEnd) {
    this.tapError('last test id does not match plan end')
  }

  var final = {
    ok: this.ok,
    count: this.count,
    pass: this.pass
  }

  if (this.fail)
    final.fail = this.fail

  if (this.bailedOut)
    final.bailout = this.bailedOut

  if (this.todo)
    final.todo = this.todo

  if (this.skip)
    final.skip = this.skip

  if (this.planStart !== -1) {
    final.plan = { start: this.planStart, end: this.planEnd }
    if (skipAll) {
      final.plan.skipAll = true
      if (this.planComment)
        final.plan.skipReason = this.planComment
    }
  }

  // We didn't get any actual tap, so just treat this like a
  // 1..0 test, because it was probably just console.log junk
  if (!this.sawValidTap) {
    final.plan = { start: 1, end: 0 }
    final.ok = true
  }

  if (this.failures.length) {
    final.failures = this.failures
  } else {
    final.failures = []
  }

  this.emit('complete', final)

  Writable.prototype.end.call(this, null, null, cb)
}

Parser.prototype.version = function (version, line) {
  // If version is specified, must be at the very beginning.
  if (version >= 13 && this.planStart === -1 && this.count === 0)
    this.emit('version', version)
  else
    this.nonTap(line)
}

Parser.prototype.pragma = function (key, value, line) {
  // can't put a pragma in a child or yaml block
  if (this.child || this.yind) {
    this.nonTap(line)
    return
  }

  this.emitResult()
  // only the 'strict' pragma is currently relevant
  if (key === 'strict') {
    this.strict = value
  }
  this.pragmas[key] = value
}

Parser.prototype.bailout = function (reason) {
  this.sawValidTap = true
  this.emitResult()
  this.bailedOut = reason || true
  this.ok = false
  this.emit('bailout', reason)
}

Parser.prototype.clearCommentQueue = function () {
  for (var c = 0; c < this.commentQueue.length; c++) {
    this.emit('comment', this.commentQueue[c])
  }
  this.commentQueue.length = 0
}

Parser.prototype.endChild = function () {
  if (this.child) {
    this.child.end()
    this.child = null
  }
}

Parser.prototype.emitResult = function () {
  this.endChild()
  this.resetYamlish()

  if (!this.current)
    return this.clearCommentQueue()

  var res = this.current
  this.current = null

  this.count++
  if (res.ok) {
    this.pass++
  } else {
    this.fail++
    if (!res.todo && !res.skip) {
      this.ok = false
      this.failures.push(res)
    }
  }

  if (res.skip)
    this.skip++

  if (res.todo)
    this.todo++

  this.emit('assert', res)
  this.clearCommentQueue()
}

Parser.prototype.startChild = function (indent, line) {
  var maybeBuffered = this.current && this.current.name.match(/{$/)

  if (!maybeBuffered)
    this.emitResult()

  this.child = new Parser({
    indent: indent,
    parent: this,
    level: this.level + 1,
    buffered: this.current
  })

  this.emit('child', this.child)
  this.child.on('bailout', this.bailout.bind(this))
  var self = this
  this.child.on('complete', function (results) {
    if (this.sawValidTap && !results.ok)
      self.ok = false
  })

  line = line.substr(indent.length)

  this.child._parse(line)
}

Parser.prototype.emitComment = function (line) {
  if (this.current || this.commentQueue.length)
    this.commentQueue.push(line)
  else
    this.emit('comment', line)
}

Parser.prototype._parse = function (line) {
  // normalize line endings
  line = line.replace(/\r\n$/, '\n')

  // After a bailout, everything is ignored
  if (this.bailedOut)
    return

  // this is a line we are processing, so emit it.
  this.emit('line', line)

  // sometimes empty lines get trimmed, but are still part of
  // a subtest or a yaml block.  Otherwise, nothing to parse!
  if (line === '\n') {
    if (this.child)
      line = this.child.indent + line
    else if (this.yind)
      line = this.yind + line
    else
      return
  }

  // check to see if the line is indented.
  // if it is, then it's either a subtest, yaml, or garbage.
  var indent = line.match(/^[ \t]*/)[0]
  if (indent) {
    this.parseIndent(line, indent)
    return
  }

  // not indented

  if (line.charAt(0) === '#') {
    this.emitComment(line)
    return
  }

  // nothing but comments can come after a trailing plan
  if (this.postPlan) {
    this.nonTap(line)
    return
  }

  // now it's maybe a thing

  var bailout = line.match(lineTypes.bailout)
  if (bailout) {
    this.bailout(bailout[1].trim())
    return
  }

  // if we have any yamlish, it's garbage now
  if (this.yind)
    this.yamlGarbage()

  var pragma = line.match(lineTypes.pragma)
  if (pragma) {
    this.pragma(pragma[2], pragma[1] === '+', line)
    return
  }

  var version = line.match(lineTypes.version)
  if (version) {
    this.version(parseInt(version[1], 10), line)
    return
  }

  var plan = line.match(lineTypes.plan)
  if (plan) {
    this.plan(+plan[1], +plan[2], (plan[3] || '').trim(), line)
    return
  }

  // buffered subtests must end with a }
  if (this.child && this.child.buffered && line === '}\n') {
    this.current.name = this.current.name.replace(/{$/, '').trim()
    this.emitResult()
    return
  }

  // streamed subtests will end when this test point is emitted
  var testPoint = line.match(lineTypes.testPoint)
  if (testPoint) {
    // note: it's weird, but possible, to have a testpoint ending in
    // { before a streamed subtest which ends with a test point
    // instead of a }.  In this case, the parser gets confused, but
    // also, even beginning to handle that means doing a much more
    // involved multi-line parse.  By that point, the subtest block
    // has already been emitted as a 'child' event, so it's too late
    // to really do the optimal thing.  The only way around would be
    // to buffer up everything and do a multi-line parse.  This is
    // rare and weird, and a multi-line parse would be a bigger
    // rewrite, so I'm allowing it as it currently is.
    this.parseTestPoint(testPoint)
    return
  }

  // at this point, anything else is not TAP data
  this.nonTap(line)
  return
}

Parser.prototype.parseIndent = function (line, indent) {
  // a child in progress, pass it on.
  if (this.child && line.indexOf(this.child.indent) === 0) {
    line = line.substr(this.child.indent.length)
    this.child.write(line)
    return
  }

  // just a comment.  We no longer treat Subtest comments as magical
  // this has to be before the yaml parsing, because # comments are
  // not valid yaml, but they are valid to have in yaml blocks in tap
  if (line.trim().charAt(0) === '#') {
    this.emitComment(line)
    return
  }

  // already yaml block in progress
  if (this.yind) {
    if (line.indexOf(this.yind) === 0) {
      if (line === this.yind + '...\n') {
        // end the yaml block
        this.processYamlish()
        return
      }
      this.yamlish += line
    } else {
      // oops!  was not actually yamlish, I guess.
      // this is a case where the indent is shortened mid-yamlish block
      // treat as garbage
      this.yamlGarbage(line)
    }
    return
  }

  // stat a yaml block under a test point
  if (this.current && !this.yind && line === indent + '---\n') {
    this.yind = indent
    return
  }


  // child test, or garbage.  to be a child test, it has to be a known
  // line type.  garbage is allowed, but ignored.  If we've already
  // seen a trailing plan, then it's definitely garbage.
  var garbage
  if (this.postPlan) {
    garbage = true
  } else {
    garbage = !lineTypeNames.some(function (type) {
      return lineTypes[type].test(line.substr(indent.length))
    })
  }

  if (garbage)
    this.nonTap(line)
  else
    this.startChild(indent, line)
}

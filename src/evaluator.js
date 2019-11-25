const socket = require('./lib/socket.js');
const Label = require('./lib/label.js');
const parser = require('./lib/parser.js');
const OT = require('./lib/ot.js');
const crypto = require('./utils/crypto.js');

/**
 * Create a new evaluator party for the circuit at the given url with the given input
 * @param {string} circuitURL - circuit URL relative to server path
 * @param {Array<number>}input - the party's input as an array of bits
 * @constructor
 */
class Evaluator {
  constructor(circuitURL, input, callback, progress, parallel = 30, throttle = 1) {
    this.circuitURL = circuitURL
    this.input = input
    this.callback = callback
    this.progress = progress == null ? () => {} : progress
    this.parallel = parallel
    this.throttle = throttle

    if (this.parallel === 0) this.parallel = Number.MAX_VALUE
  }

  start() {
    socket.join('evaluator')
    socket.hear('go').then(() => this.load_circuit())
  }

  load_circuit() {
    const promise = parser.circuit_load_bristol(this.circuitURL)
    promise.then(circuit => {
      this.circuit = circuit
      for (let i = 0; i < circuit.wires; i++) this.Wire.push([])
      this.init()
    })
  }

  log() {
    // console.log.apply(console, arguments)
  }

  init() {
    
    // Total input
    const input = (new Array(1 + this.input.length)).concat(this.input)

    // All required message promises to evaluate
    const messages = [socket.get('gates')] // Promise to the garbled gates

    // Promises to each of the garbler's input labels
    for (let i = 0; i < this.circuit.input.length / 2; i++) {
      this.log('listen for Wire', this.circuit.input[i])
      messages.push(socket.get('Wire' + this.circuit.input[i]))
    }

    // Promises to each of the evaluator's input labels
    for (let i = this.circuit.input / 2; i < this.circuit.input.length; i++) {
      this.log('obliviousT ask for wire', this.circuit.input[i], 'with value', input[this.circuit.input[i]])
      messages.push(OT.receive(input[this.circuit.input[i]]))
    }

    // Wait until all messages are received
    Promise.all(messages).then(msg => {
      this.log('msg', msg)

      this.gates = JSON.parse(msg[0])
      this.circuit.input.forEach(j => {
        this.Wire[j] = Label(msg[j])
        this.log('Wire', j, this.Wire)
      })

      this.evaluate(0)
    })
  }

  evaluate(start) {
    for (let i = start; i < start + this.parallel && i < this.circuit.gates; i++) {
      const gate = this.circuit.gate[i]
      this.evaluate_gate(this.gates[i], gate.type, gate.wirein, gate.wireout)
    }

    start += this.parallel
    this.progress(Math.min(start, this.circuit.gates), this.circuit.gates)

    if (start >= this.circuit.gates) { // done
      this.finish()
      return
    }

    if (this.throttle > 0) {
      setTimeout(() => this.evaluate(start), this.throttle)
    } else {
      this.evaluate(start)
    }
  }

  finish() {

    // Collect all output wires' labels and send them back to the garbler for decoding
    const evaluation = this.circuit.output.reduce((acc, j) => {
      acc[j] = this.Wire[j].stringify()
      this.log('j', j, this.Wire[j])
      return acc
    }, {})
    socket.give('evaluation', evaluation)

    // Receive decoded output states
    socket.get('results').then(results => {
      if (this.circuitURL === 'circuits/aes128.txt') results = results.reverse()
      this.callback(results.join(''))
    })
  }

  /*
   *  Decrypt a single garbled gate
   *  The resultant label is stored automatically and also returned
   */
  evaluate_gate(gate, type, wirein, wireout) {
    this.log('evaluate_gate', gate, wirein, wireout)

    const i = wirein[0]
    const j = (wirein.length === 2) ? wirein[1] : i
    const k = (wireout != null) ? wireout : 0 // if null, just return decrypted
    const l = 2 * this.Wire[i].pointer() + this.Wire[j].pointer()

    switch (type) {
      case 'xor':
        this.Wire[k] = this.Wire[i].xor(this.Wire[j])
        break
      case 'not':
        this.Wire[k] = this.Wire[i] // already inverted
        break
      case 'and':
        this.Wire[k] = crypto.decrypt(this.Wire[i], this.Wire[j], k, Label(gate[l]))
        break
    }
  }
}

module.exports = Evaluator;

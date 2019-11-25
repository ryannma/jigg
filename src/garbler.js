const socket = require('./lib/socket.js');
const Label = require('./lib/label.js');
const parser = require('./lib/parser.js');
const OT = require('./lib/ot.js');
const randomutils = require('./utils/random.js');
const crypto = require('./utils/crypto.js');

/**
 * Create a new evaluator party for the circuit at the given url with the given input
 * @param {string} circuitURL - circuit URL relative to server path
 * @param {Array<number>}input - the party's input as an array of bits
 * @constructor
 */
class Garbler {
  constructor(circuitURL, input, callback, progress, parallel = 30, throttle = 1) {
    this.circuitURL = circuitURL
    this.input = input
    this.callback = callback
    this.progress = progress == null ? () => {} : progress
    this.parallel = parallel
    this.throttle = throttle
    this.Wire = [null]
    this.gates = []

    if (this.parallel === 0) this.parallel = Number.MAX_VALUE
  }

  start() {
    socket.join('garbler')
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
    // User input
    const inputs = (new Array(1)).concat(this.input).concat(new Array(this.input.length));
    this.log('input states', inputs)

    // Generate labels and save it in this.wire
    this.generate_labels()

    // Give the evaluator the first half of the input labels
    for (let i = 0; i < this.circuit.input.length/2; i++) {
      const j = this.circuit.input[i]
      this.log('give Wire' + j, i, this.circuit.input, inputs[j], this.Wire[j][1], this.Wire[j][0], inputs[j] ? this.Wire[j][1] : this.Wire[j][0])
      socket.give('Wire' + j, inputs[j] ? this.Wire[j][1] : this.Wire[j][0])
    }

    // Use oblivious transfer for the second half of the input labels
    for (let i = this.circuit.input.length/2; i < this.circuit.input.length; i++) {
      const j = this.circuit.input[i]
      this.log('transfer for Wire' + j)
      OT.send(this.Wire[j][0], this.Wire[j][1])
    }

    this.garble(0)
  }

  // Generate labels and encode each state of every wire with a randomly generated label
  generate_labels() {
    const R = randomutils.random() // R in {0, 1}^N
    this.circuit.input.forEach(i => {
      // const i = this.circuit.input[j]

      const label = randomutils.random()
      this.Wire[i][0] = label
      this.Wire[i][1] = label.xor(R)

      const point = randomutils.random_bit()
      this.Wire[i][0].pointer(point)
      this.Wire[i][1].pointer(1-point)
    })

    this.circuit.gate.forEach(gate => {
      const { type, wirein, wireout } = gate
      if (type === 'xor') {
        const a = this.Wire[wirein[0]][0]
        const b = this.Wire[wirein[1]][0]

        this.Wire[wireout][0] = a.xor(b).point(a.pointer() ^ b.pointer())
        this.Wire[wireout][1] = a.xor(b).xor(R).point(a.pointer() ^ b.pointer() ^ 1) // What is the point of ^1?
      } else if (type === 'and') {
        const key = randomutils.random()
        const point = randomutils.random_bit()

        this.Wire[wireout][0] = key.point(point)
        this.Wire[wireout][1] = key.xor(R).point(point ^ 1) // What is the point of ^1?
      } else if (type === 'not') {
        this.Wire[wireout][0] = this.Wire[wirein[0]][1]
        this.Wire[wireout][1] = this.Wire[wirein[0]][0]
      } else {
        throw new Error(`Unsupported gate type '${type}'`)
      }
    })

    this.log('Wire', this.Wire)
  }

  garble(start) {

    //Garble all gates
    for (let i = start; i < start + this.parallel && i < this.circuit.gates; i++) {
      const gate = this.circuit.gate[i]
      this.gates[i] = this.garble_gate(gate.type, gate.wirein, gate.wireout)
    }

    start += this.parallel
    this.progress(Math.min(start, this.circuit.gates), this.circuit.gates)

    if (start >= this.circuit.gates) {
      this.finish()
      return
    }

    if (this.throttle > 0) {
      setTimeout(() => this.garble(start), this.throttle)
    } else {
      this.garble(start)
    }
  }

  finish() {

    // Give the garbled gates to evaluator
    socket.give('gates', JSON.stringify(this.gates))

    // Get output labels and decode them back to their original values
    socket.get('evaluation').then(evaluation => {
      let results = this.circuit.output.map(output => {
        const label = evaluation[output] // wire output label
        const states = this.Wire[output].map(Label.prototype.stringify) // True and false labels
        const value = states.map(e => e.substring(0, e.length-3))
                            .indexOf(label.substring(0, label.length-3)) // find which state the label represents
        return value
      })

      socket.give('results', results)
      this.log('results', results)

      if (this.circuitURL === 'circuits/aes128.txt') results = results.reverse()
      results = results.join('')
      this.callback(results)
    })

    socket.give('finish', 'finish')
  }

  /*
   *  Encrypt a single gate
   *  Input and output wires must have labels at this point.
   */
  garble_gate(type, wirein, wireout) {
    this.log('garble_gate', type, wirein, wireout)

    const i = wirein[0]
    const j = wirein.length === 2 ? wirein[1] : i
    const k = wireout
    
    switch (type) {
      case 'xor':
        return 'xor' // free xor - encrypt nothing
      case 'not':
        return 'not'
      case 'and':
        const t = [0, 0, 0, 1]
        return [
          [crypto.encrypt(this.Wire[i][0], this.Wire[j][0], k, this.Wire[k][t[0]]).stringify(), (2 * this.Wire[i][0].pointer()) + this.Wire[j][0].pointer()],
          [crypto.encrypt(this.Wire[i][0], this.Wire[j][1], k, this.Wire[k][t[1]]).stringify(), (2 * this.Wire[i][0].pointer()) + this.Wire[j][1].pointer()],
          [crypto.encrypt(this.Wire[i][1], this.Wire[j][0], k, this.Wire[k][t[2]]).stringify(), (2 * this.Wire[i][1].pointer()) + this.Wire[j][0].pointer()],
          [crypto.encrypt(this.Wire[i][1], this.Wire[j][1], k, this.Wire[k][t[3]]).stringify(), (2 * this.Wire[i][1].pointer()) + this.Wire[j][1].pointer()]
        ].sort((c1, c2) => c1[1]-c2[1]) // point-and-permute
         .map(c => c = c[0])
      // --Define any other gates here--
    }
  }
}

module.exports = Garbler;

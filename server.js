const express = require('express')
const app = express()
const http = require('http').createServer(app)
const io = require('socket.io')(http)
const sodium = require('libsodium-wrappers')

// Global settings (to remove)
global.fetch = require('node-fetch')
global.sodium = sodium

// Src libs
const { Garbler, bin2hex, hex2bin } = require('./src/jigg.js')

// Helper Constants
const DETAILED_LOGS = true

// Static paths
app.use('/dist', express.static(__dirname + '/dist/'))
app.use('/circuits', express.static(__dirname + '/circuits/'))
app.get('/datavant', (req, res) => res.sendFile(__dirname + '/demo/datavant_demo.html'))

// Endpoint for garbler POST
app.post('/garbler_sha256', (req, res) => {
  const input = '00000000000000000000000000000000'
  const bin_input = hex2bin(input)
  const formatted_input = bin_input.split('').reverse().map(JSON.parse)

  const progress = (start, total) => console.log('Progress', start, '/', total)

  const cb = (results) => {
    results = bin2hex(results)
    console.log('Results: ' + results)
  }

  const circuitURL = 'circuits/sha256.txt'
  const garbler = new Garbler(circuitURL, formatted_input, cb, progress, 0, 0)
  garbler.start()

  res.send('200 OK\n')
})

const port = (process.argv.length === 3) ? process.argv[2] : 3000
http.listen(port, () => console.log('listening on *:' + port))



/* Socket.io section */

// Get new components
const getNewComponents = () => {
  return {
    party: { garbler: null, evaluator: null },
    mailbox: { garbler: {}, evaluator: {} },
    cache: []
  }
}

const { party, mailbox, cache } = getNewComponents()
io.on('connection', (socket) => {
  socket.on('join', (msg) => {
    if (msg === 'garbler' || (!(msg === 'evaluator') && party.garbler == null)) {
      on_join(socket, party, mailbox, 'garbler')
    } else if (msg === 'evaluator' || party.evaluator == null) {
      on_join(socket, party, mailbox, 'evaluator')
    }
    if (party.garbler != null && party.evaluator != null) {
      console.log('Both parties connected')
      io.to(party.garbler).emit('go')
      io.to(party.evaluator).emit('go')
    }

    if (msg === 'finish') {
      party.garbler = null
      mailbox.garbler = {}
      console.log('Garbler disconnected')
    }
  })

  socket.on('send', (tag, msg) => {
    if (DETAILED_LOGS) console.log('send', tag, msg)
    if (socket.id === party.garbler) {
      on_send(tag, msg, mailbox, 'evaluator')
    }
    if (socket.id === party.evaluator) {
      on_send(tag, msg, mailbox, 'garbler')
    }
  })

  socket.on('listening for', (tag) => {
    if (DETAILED_LOGS) console.log('listening for', tag)
    if (socket.id === party.garbler) {
      on_listening_for(tag, io, party, mailbox, 'garbler')
    }
    if (socket.id === party.evaluator) {
      on_listening_for(tag, io, party, mailbox, 'evaluator')
    }
  })

  socket.on('oblv', (params) => {
    if (DETAILED_LOGS) console.log('oblv', params)
    const { msg_id, length } = params

    let r0, r1
    if (cache[msg_id] === undefined) cache[msg_id] = { unused: true }
    if (cache[msg_id].unused) {
      [r0, r1] = [[], []]
      for (let i = 0; i < length; i++) {
        r0[i] = sodium.randombytes_uniform(256)
        r1[i] = sodium.randombytes_uniform(256)
      }
      cache[msg_id].r0 = r0
      cache[msg_id].r1 = r1
      cache[msg_id].unused = false
    } else {
      r0 = cache[msg_id].r0
      r1 = cache[msg_id].r1
      cache[msg_id] = { unused: true } // clear cache
    }

    if (socket.id === party.garbler) {
      socket.emit('oblv' + msg_id, JSON.stringify([r0, r1]))
    }

    if (socket.id === party.evaluator) {
      const d = sodium.randombytes_uniform(2)
      socket.emit('oblv' + msg_id, JSON.stringify([d, d ? r1 : r0]))
    }
  })
})

exports.close = () => {
  try {
    console.log('Closing server')
    io.to(party.garbler).emit('shutdown', 'finished')
    io.to(party.evaluator).emit('shutdown', 'finished')
    io.close()
    http.close()
    console.log('Server closed')
  } catch (e) {
    console.log('Closing with error', e)
  }
}

// Helper function for io 'join'
const on_join = (socket, party, mailbox, side) => {
  console.log(`${side} connected`)
  party[side] = socket.id
  socket.emit('whoami', side)
  socket.on('disconnect', () => {
    party[side] = null
    mailbox[side] = {}
    console.log(`${side} disconected`)
  })
}

// Helper function for io 'send'
const on_send = (tag, msg, mailbox, side) => {
  if (typeof(mailbox[side][tag]) !== 'undefined' && mailbox[side][tag] != null) {
    mailbox[side][tag](msg)
  } else {
    mailbox[side][tag] = msg
  }
}

// Helper function for io 'listening for'
const on_listening_for = (tag, io, party, mailbox, side, detailed_logs = DETAILED_LOGS) => {
  if (typeof(mailbox[side][tag]) !== 'undefined' && mailbox[side][tag] !== null) {
    const msg = mailbox[side][tag]
    if (detailed_logs) console.log('sent', tag, msg, `to ${side}`)
    io.to(party[side]).emit(tag, msg)
    mailbox[side][tag] = null
  } else {

    // What is happening here?
    (new Promise((resolve, reject) => {
      mailbox[side][tag] = resolve
    })).then(msg => {
      if (detailed_logs) console.log('sent', tag, msg, `to ${side} (as promised)`)
      io.to(party[side]).emit(tag, msg)
      mailbox[side][tag] = null
    })
  }
}

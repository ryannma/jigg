const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  pingTimeout: 25000,
  pingInterval: 50000
});
global.sodium = require('libsodium-wrappers');
global.fetch = require('node-fetch');
const { Garbler, bin2hex, hex2bin } = require('./src/jigg.js');
const DETAILED_LOGS = false

// Static paths
app.use('/dist', express.static(__dirname + '/dist/'));
app.use('/circuits', express.static(__dirname + '/circuits/'));
app.get('/datavant', (request, response) => response.sendFile(__dirname + '/demo/datavant_demo.html'));

// Endpoint for garbler POST
app.post('/garbler_sha256', function (req, res) {
  const input = "00000000000000000000000000000000"
  const bin_input = hex2bin(input)
  const formatted_input = bin_input.split('').reverse().map(JSON.parse);

  const progress = (start, total) => console.log('Progress', start, '/', total)

  const callback = (results) => {
    results = bin2hex(results)
    console.log('Results: ' + results)
  };

  const circuitURL = 'circuits/sha256.txt';
  const garbler = new Garbler(circuitURL, formatted_input, callback, progress, 0, 0);
  garbler.start();

  res.send('200 OK\n')
});


const port = (process.argv.length === 3)? process.argv[2] : 3000;
http.listen(port, () => console.log('listening on *:'+port));

// Get new components
const getNewComponents = () => {
  return {
    party: { garbler: null, evaluator: null },
    mailbox: { garbler: {}, evaluator: {} },
    cache: []
  }
}

const { party, mailbox, cache } = getNewComponents()
io.on('connection', function (socket) {
  socket.on('join', function (msg) {
    if (msg === 'garbler' || (!(msg === 'evaluator') && party.garbler == null)) {
      party.garbler = socket.id;
      console.log('Garbler connected');
      socket.emit('whoami', 'garbler');
      socket.on('disconnect', function() {
        party.garbler = null;
        mailbox.garbler = {};
        console.log('Garbler disconnected');
      });
    } else if (msg === 'evaluator' || party.evaluator == null) {
      party.evaluator = socket.id;
      console.log('Evaluator connected');
      socket.emit('whoami', 'evaluator');
      socket.on('disconnect', function() {
        party.evaluator = null;
        mailbox.evaluator = {};
        console.log('Evaluator disconnected');
      });
    }
    if (party.garbler != null && party.evaluator != null) {
      console.log('Both parties connected.');
      io.to(party.garbler).emit('go');
      io.to(party.evaluator).emit('go');
    }

    if (msg === 'finish') {
      party.garbler = null;
      mailbox.garbler = {};
      console.log('Garbler disconnected');
    }
  });

  socket.on('send', function(tag, msg) {
    if (DETAILED_LOGS) console.log('send', tag, msg)
    if (socket.id === party.garbler) {
      if (typeof(mailbox.evaluator[tag]) !== 'undefined' && mailbox.evaluator[tag] != null) {
        mailbox.evaluator[tag](msg);
      } else {
        mailbox.evaluator[tag] = msg;
      }
    }
    if (socket.id === party.evaluator) {
      if (typeof(mailbox.garbler[tag]) !== 'undefined' && mailbox.garbler[tag] != null) {
        mailbox.garbler[tag](msg);
      } else {
        mailbox.garbler[tag] = msg;
      }
    }
  });

  socket.on('listening for', function(tag) {
    if (DETAILED_LOGS) console.log('listening for', tag)
    if (socket.id === party.garbler) {
      if (typeof(mailbox.garbler[tag]) !== 'undefined' && mailbox.garbler[tag] != null) {
        const msg = mailbox.garbler[tag];
        if (DETAILED_LOGS) console.log('sent', tag, msg, 'to garbler');
        io.to(party.garbler).emit(tag, msg);
        mailbox.garbler[tag] = null;
      } else {
        (new Promise(function(resolve, reject) {
          mailbox.garbler[tag] = resolve;
        })).then(function (msg) {
          if (DETAILED_LOGS) console.log('sent', tag, msg, 'to garbler (as promised)');
          io.to(party.garbler).emit(tag, msg);
          mailbox.garbler[tag] = null;
        });
      }
    }
    if (socket.id === party.evaluator) {
      if (typeof(mailbox.evaluator[tag]) !== 'undefined' && mailbox.evaluator[tag] != null) {
        const msg = mailbox.evaluator[tag];
        if (DETAILED_LOGS) console.log('sent', tag, msg, 'to evaluator');
        io.to(party.evaluator).emit(tag, msg);
        mailbox.evaluator[tag] = null;
      } else {
        (new Promise(function(resolve, reject) {
          mailbox.evaluator[tag] = resolve;
        })).then(function (msg) {
          if (DETAILED_LOGS) console.log('sent', tag, msg, 'to evaluator (as promised)');
          io.to(party.evaluator).emit(tag, msg);
          mailbox.evaluator[tag] = null;
        });
      }
    }
  });

  socket.on('oblv', function(params) {
    if (DETAILED_LOGS) console.log('oblv', params);
    const msg_id = params.msg_id;
    const length = params.length;

    var r0, r1;
    if (cache[msg_id] === undefined || cache[msg_id].unused) {
      if (cache[msg_id] === undefined) {
        cache[msg_id] = {unused: true};  // or with just {}
      }
      r0 = [];
      r1 = [];
      for (var i = 0; i < length; i++) {  // or with map(...)
        r0[i] = sodium.randombytes_uniform(256);
        r1[i] = sodium.randombytes_uniform(256);
      }
      cache[msg_id].r0 = r0;
      cache[msg_id].r1 = r1;
      cache[msg_id].unused = false;
    } else {
      r0 = cache[msg_id].r0;
      r1 = cache[msg_id].r1;
      cache[msg_id] = {unused: true};  // clear cache
    }

    if (socket.id === party.garbler) {
      socket.emit('oblv'+msg_id, JSON.stringify([r0, r1]));
    }

    if (socket.id === party.evaluator) {
      const d = sodium.randombytes_uniform(2);
      socket.emit('oblv'+msg_id, JSON.stringify([d, d ? r1 : r0]));
    }
  });
});

exports.close = function () {
  try {
    console.log('Closing server');
    io.to(party.garbler).emit('shutdown', 'finished');
    io.to(party.evaluator).emit('shutdown', 'finished');
    io.close();
    http.close();
    console.log('Server closed');
  } catch (e) {
    console.log('Closing with error', e);
  }
};

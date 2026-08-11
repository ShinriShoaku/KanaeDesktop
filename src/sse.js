"use strict";

const MAX_SSE_CLIENTS = 20;

/** Each client is a raw Express `res` object with SSE headers already sent. */
const clients = new Set();

function addClient(res) {
  if (clients.size >= MAX_SSE_CLIENTS) {
    const oldest = clients.values().next().value;
    if (oldest) {
      clients.delete(oldest);
      try {
        oldest.end();
      } catch (e) {
        /* ignore */
      }
    }
  }
  clients.add(res);
}

function removeClient(res) {
  clients.delete(res);
}

function sendEvent(res, eventType, data) {
  try {
    res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch (e) {
    /* client likely disconnected; will be reaped on 'close' */
  }
}

/** Broadcast an event to all connected OBS overlay SSE clients. */
function broadcast(eventType, data) {
  for (const res of clients) {
    sendEvent(res, eventType, data);
  }
}

module.exports = { addClient, removeClient, sendEvent, broadcast, clients };

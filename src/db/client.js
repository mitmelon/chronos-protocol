'use strict';

const { MongoClient } = require('mongodb');
const config = require('../config');

let _db = null;
let _client = null;

async function connect() {
  if (_db) return _db;
  _client = new MongoClient(config.mongodb.uri);
  await _client.connect();
  _db = _client.db();
  console.log('[db] Connected to MongoDB');
  return _db;
}

function db() {
  if (!_db) throw new Error('MongoDB not connected. Call connect() first.');
  return _db;
}

async function close() {
  if (_client) {
    await _client.close();
    _db = null;
    _client = null;
  }
}

module.exports = { connect, db, close };

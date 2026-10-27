'use strict';

const { MongoClient } = require('mongodb');
const config = require('../config');

let _db = null;
let _client = null;

/** Host and database for log lines. Never prints credentials. */
function describe() {
  const host = config.mongodb.uri.replace(/^mongodb(\+srv)?:\/\/([^@/]*@)?/, '').split(/[/?]/)[0];
  return `${host}/${config.mongodb.dbName}`;
}

async function connect() {
  if (_db) return _db;
  const { uri, dbName, authSource } = config.mongodb;
  const client = new MongoClient(uri, { ...(authSource ? { authSource } : {}), serverSelectionTimeoutMS: 10000 });
  try {
    await client.connect();
    _db = client.db(dbName);
    await _db.command({ ping: 1 }); // forces authentication to be checked now, not on the first query
  } catch (err) {
    _db = null;
    await client.close().catch(() => {});
    if (err.codeName === 'AuthenticationFailed' || err.code === 18) {
      throw new Error(
        `MongoDB authentication failed for ${describe()} (login database "${authSource || 'from the URI'}").\n` +
        '  - Check the username and password in MONGODB_URI (percent-encode special characters: @ is %40, : is %3A, / is %2F).\n' +
        '  - The user must exist in the login database. Users created with MONGO_INITDB_ROOT_USERNAME or in Atlas live in "admin".\n' +
        '    If yours was created inside the app database, set MONGODB_AUTH_SOURCE=<that database>.\n' +
        '  - Keep the database name in MONGODB_DB_NAME, not in the URI path.'
      );
    }
    throw err;
  }
  _client = client;
  console.log(`[db] Connected to MongoDB (${describe()})`);
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

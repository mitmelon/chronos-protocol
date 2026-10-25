const solc = require('solc'), fs = require('fs'), path = require('path');
const sources = { 'contracts/Chronos.sol': { content: fs.readFileSync('../../contracts/Chronos.sol', 'utf8') }, 'contracts/MockUSDC.sol': { content: fs.readFileSync('./MockUSDC.sol', 'utf8') } };
const input = { language: 'Solidity', sources, settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
const findImports = (p) => { try { return { contents: fs.readFileSync(path.join('node_modules', p), 'utf8') }; } catch { return { error: 'not found ' + p }; } };
const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
const errs = (out.errors || []);
errs.filter((e) => e.severity === 'warning' && !/SPDX|license/i.test(e.message)).forEach((e) => console.log('WARN', e.formattedMessage.split('\n')[0]));
const fatal = errs.filter((e) => e.severity === 'error'); if (fatal.length) { fatal.forEach((e) => console.log(e.formattedMessage)); process.exit(1); }
fs.mkdirSync('out', { recursive: true });
for (const [file, cs] of Object.entries(out.contracts)) for (const [name, c] of Object.entries(cs)) if (['Chronos', 'MockUSDC'].includes(name)) fs.writeFileSync(`out/${name}.json`, JSON.stringify({ abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }));
console.log('compiled ok:', fs.readdirSync('out').join(', '), '| Chronos bytecode bytes:', JSON.parse(fs.readFileSync('out/Chronos.json')).bytecode.length / 2 - 1);

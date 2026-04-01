import { spawn } from 'child_process';
const p = spawn('node', ['server.js'], { cwd: './backend' });
p.stdout.on('data', d => process.stdout.write(d));
p.stderr.on('data', d => process.stderr.write(d));
p.on('close', code => console.log('Exited with code:', code));

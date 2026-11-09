// Development: Revspan server in watch mode (port 7420) + Vite with hot reload (port 5173).
// Ctrl+C stops both; if one stops, the other does too.
import { spawn, type ChildProcess } from 'node:child_process';

const children: ChildProcess[] = [
    spawn(process.execPath, ['--watch', '--disable-warning=ExperimentalWarning', 'src/server/main.ts', '--no-open'], { stdio: 'inherit' }),
    spawn('npm', ['run', 'dev:web'], { stdio: 'inherit' }),
];

let stopping = false;
function stop(code: number): void {
    if (stopping) {
        return;
    }
    stopping = true;
    for (const child of children) {
        if (child.exitCode === null) {
            child.kill('SIGTERM');
        }
    }
    process.exitCode = code;
}

for (const child of children) {
    child.on('exit', (code) => stop(code ?? 0));
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

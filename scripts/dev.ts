// Développement : serveur Strata en watch (port 7420) + Vite avec rechargement à chaud (port 5173).
// Ctrl+C arrête les deux ; si l'un s'arrête, l'autre aussi.
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

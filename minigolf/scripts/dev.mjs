// Runs the game server and the Vite client together.
import { spawn } from "node:child_process";

const run = (script) => spawn("npm", ["run", script], { stdio: "inherit", shell: true });
const children = [run("dev:server"), run("dev:client")];
const stop = () => children.forEach((c) => c.kill());
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

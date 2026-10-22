// Entry file that Lambda loads from the root of the package. adapter-node listens on
// HOST and PORT, so they are set from the address Lambda gives before the server starts;
// the fallback is for local runs.
const [host, port] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT ?? "localhost:3000").split(":");
process.env.HOST = host;
process.env.PORT = port;

await import("./build/index.js");

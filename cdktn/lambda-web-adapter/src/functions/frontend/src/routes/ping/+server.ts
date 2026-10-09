// Readiness check for the Lambda Web Adapter.
export function GET() {
  return new Response("pong");
}

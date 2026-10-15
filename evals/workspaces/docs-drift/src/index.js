// Orders API entry point.
const PORT = Number(process.env.PORT ?? 3000);
export function start() {
  return { port: PORT };
}

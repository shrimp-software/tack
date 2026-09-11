export async function run(input) {
  if (input && input.sleepMs) await new Promise((resolve) => setTimeout(resolve, input.sleepMs));
  if (input && input.memoryPressure) { const heap = []; while (true) heap.push(new Array(100000).fill(heap.length)); }
  if (input && input.fail) throw new Error('handler_failed');
  return input;
}

export async function run(input) {
  await new Promise((resolve) => setTimeout(resolve, input?.sleepMs ?? 0));
  return { keys: input && typeof input === "object" ? Object.keys(input).sort() : [] };
}

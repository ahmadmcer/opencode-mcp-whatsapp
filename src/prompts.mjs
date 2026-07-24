// Zero-dependency prompt primitives built on node:readline -- deliberately
// no `inquirer`/`prompts` package, since this is a bootstrap script and
// should have no install friction of its own.
//
// IMPORTANT: does NOT use readline's `question()` method. Consuming the
// interface via its async iterator queues every line safely regardless of
// arrival timing (piped stdin can deliver several lines in one chunk, which
// makes repeated question() calls drop answers and hang), and works
// identically for real interactive typing.

export function createPrompter(rl) {
  const it = rl[Symbol.asyncIterator]();
  async function rawLine(label) {
    process.stdout.write(label);
    const { value, done } = await it.next();
    return done ? "" : value;
  }
  return { rawLine };
}

export async function promptText(prompter, question, { default: def, validate } = {}) {
  while (true) {
    const label = def ? `${question} [${def}]: ` : `${question}: `;
    const raw = (await prompter.rawLine(label)).trim();
    const value = raw || def || "";
    if (!validate) return value;
    const result = validate(value);
    if (result.ok) return value;
    console.log(`  x ${result.message}`);
  }
}

export async function promptYesNo(prompter, question, defaultYes = true) {
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  while (true) {
    const raw = (await prompter.rawLine(`${question} ${suffix}: `)).trim().toLowerCase();
    if (raw === "") return defaultYes;
    if (raw === "y" || raw === "yes") return true;
    if (raw === "n" || raw === "no") return false;
    console.log("  Please answer y or n.");
  }
}

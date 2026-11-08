/** Runtime-option echoes can contain credentials; raw local diagnostics remain separate. */
export function shareableDiagnostic(input) {
  let text = String(input);
  for (const name of [
    'JAVA_TOOL_OPTIONS',
    'JDK_JAVA_OPTIONS',
    '_JAVA_OPTIONS',
  ]) {
    const value = process.env[name];
    if (value) text = text.replaceAll(value, `[${name} values omitted]`);
  }
  return text;
}

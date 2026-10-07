// Run the E2E tests against the dev build (default) or an installed/unpacked app:
//   $env:STUDIO_EXE = "..\..\build\studio\win-unpacked\Autoflow Studio.exe"; pnpm exec playwright test
export function launchTarget(): { args: string[]; executablePath?: string } {
  const exe = process.env.STUDIO_EXE;
  return exe ? { args: [], executablePath: exe } : { args: ['.'] };
}

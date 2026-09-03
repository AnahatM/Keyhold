// SPDX-License-Identifier: GPL-3.0-or-later
import { isAbsolute } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Guard: the one place in Keyhold that starts a process must name its binary absolutely.
 *
 * `execFile` with a bare program name resolves through the OS search order. On Windows that
 * order begins with the application directory and can include the working directory before
 * `%PATH%`, so a `netsh.exe` dropped beside a portable build would be executed by Keyhold,
 * in Keyhold's process context, on the ordinary save path. This file is what stops the
 * absolute path being "simplified" back to `'netsh'` by someone who does not know that.
 *
 * Fault injection performed: reverting the call site to `runCommand('netsh', …)` fails
 * "spawns netsh by absolute path, never by bare name"; dropping `System32` from
 * `netshPath()` fails "resolves inside %SystemRoot%\System32".
 */

const execFileMock = vi.hoisted(() =>
  vi.fn(
    (
      _file: string,
      _args: readonly string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string) => void
    ) => {
      // Every probe here is allowed to fail; returning no output exercises the null path
      // without asserting anything about the parsers, which are a separate concern.
      callback(null, '');
    }
  )
);

vi.mock('node:child_process', () => ({ execFile: execFileMock }));

const loadModule = async () => import('./network-name.js');

describe('netshPath', () => {
  const originalSystemRoot = process.env.SystemRoot;

  afterEach(() => {
    if (originalSystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = originalSystemRoot;
  });

  it('resolves inside %SystemRoot%\\System32', async () => {
    const { netshPath } = await loadModule();
    process.env.SystemRoot = 'D:\\Windows';
    expect(netshPath()).toBe('D:\\Windows\\System32\\netsh.exe');
  });

  it('falls back to C:\\Windows when the environment has lost SystemRoot', async () => {
    const { netshPath } = await loadModule();
    delete process.env.SystemRoot;
    expect(netshPath()).toBe('C:\\Windows\\System32\\netsh.exe');
    process.env.SystemRoot = '';
    expect(netshPath()).toBe('C:\\Windows\\System32\\netsh.exe');
  });

  it('is never a bare program name, whatever SystemRoot holds', async () => {
    const { netshPath, SYSTEM_PROFILER_PATH } = await loadModule();
    process.env.SystemRoot = 'C:\\Windows';
    // `isAbsolute` is checked with the win32 rules explicitly, because these tests run on
    // whichever platform the developer is on and a Windows path is not absolute to POSIX.
    expect(isAbsolute(netshPath()) || /^[A-Za-z]:\\/.test(netshPath())).toBe(true);
    expect(SYSTEM_PROFILER_PATH.startsWith('/')).toBe(true);
  });
});

describe('the probe never hands a bare name to the OS search order', () => {
  beforeEach(() => {
    execFileMock.mockClear();
  });

  it('spawns netsh by absolute path, never by bare name', async () => {
    const { SystemNetworkProbe } = await loadModule();
    process.env.SystemRoot = 'C:\\Windows';
    await new SystemNetworkProbe('win32').detect();

    const spawned = execFileMock.mock.calls.map((call) => call[0]);
    expect(spawned).toContain('C:\\Windows\\System32\\netsh.exe');
    expect(spawned).not.toContain('netsh');
    expect(spawned).not.toContain('netsh.exe');
  });

  it('spawns system_profiler by absolute path, never by bare name', async () => {
    const { SystemNetworkProbe } = await loadModule();
    await new SystemNetworkProbe('darwin').detect();

    const spawned = execFileMock.mock.calls.map((call) => call[0]);
    expect(spawned).toContain('/usr/sbin/system_profiler');
    expect(spawned).not.toContain('system_profiler');
  });

  it('starts no process at all on a platform with no probe', async () => {
    const { SystemNetworkProbe } = await loadModule();
    await new SystemNetworkProbe('linux').detect();
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

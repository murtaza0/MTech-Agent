# Execution and preview

`POST /api/mtech/projects/:id/execution` accepts a command and optional
argument array. The command must be one of `npm`, `pnpm`, `yarn`, `node`,
`python`, `python3`, `pip`, `pip3`, `git`, `bash`, or `sh`. Shell strings,
privileged commands, network downloaders, credential paths, and system paths
are rejected.

The response records command, project cwd, stdout, stderr, exit code, start and
end time, and status. Project scripts are discovered from `package.json` and
run by the execution task.

Preview startup discovers a project with `dev`, `preview`, or `start` scripts,
starts it as a child process, waits for an HTTP response, and only then returns
`running` with the real pid, port, URL, and framework. Stop and restart send a
real process signal. If health never succeeds, startup returns an error and
the process is terminated.
import { posix } from 'node:path';
import { Project, ts } from 'ts-morph';

// Resolution reads only the snapshot, including configuration and workspace manifests.
export function createProject(files: Record<string, string>): Project {
  const packages = new Map<string, string>();
  for (const [path, text] of Object.entries(files)) {
    if (posix.basename(path) !== 'package.json') continue;
    const { name } = JSON.parse(text);
    if (name) packages.set(name, `/repo/${posix.dirname(path)}`);
  }
  const realpath = (path: string) => {
    const match = path.match(/\/node_modules\/((?:@[^/]+\/)?[^/]+)(.*)$/);
    const directory = match && packages.get(match[1]!);
    return directory ? posix.normalize(directory + match![2]) : path;
  };
  const defaults: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    moduleDetection: ts.ModuleDetectionKind.Force,
    target: ts.ScriptTarget.ES2022,
    skipLibCheck: true,
  };
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: defaults,
    resolutionHost: (moduleHost) => {
      const host: ts.ParseConfigFileHost = {
        ...moduleHost,
        useCaseSensitiveFileNames: true,
        getCurrentDirectory: () => '/repo',
        fileExists: (path) => moduleHost.fileExists(realpath(path)),
        readFile: (path) => moduleHost.readFile(realpath(path)),
        directoryExists: (path) =>
          /\/node_modules(?:\/@[^/]+)?$/.test(path) || moduleHost.directoryExists!(realpath(path)),
        realpath,
        readDirectory: () => [],
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
          throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
        },
      };
      const configs = new Map<string, ts.CompilerOptions>();
      return {
        resolveModuleNames(names, containingFile, _reused, _redirected, _options, sourceFile) {
          const config = ts.findConfigFile(posix.dirname(containingFile), host.fileExists);
          let options = defaults;
          if (config) {
            if (!configs.has(config)) {
              const parsed = ts.getParsedCommandLineOfConfigFile(config, {}, host)!;
              // 6053: an `extends` target outside the snapshot, such as a base
              // shipped in node_modules. The config's own options still parse.
              const errors = parsed.errors.filter(({ code }) => code !== 18003 && code !== 6053);
              if (errors.length) {
                throw new Error(
                  errors
                    .map(({ messageText }) => ts.flattenDiagnosticMessageText(messageText, '\n'))
                    .join('\n'),
                );
              }
              configs.set(config, { ...defaults, ...parsed.options });
            }
            options = configs.get(config)!;
          }
          return names.map((name, index) => {
            const mode = sourceFile
              ? ts.getModeForResolutionAtIndex(
                  {
                    ...sourceFile,
                    impliedNodeFormat: ts.getImpliedNodeFormatForFile(
                      containingFile as ts.Path,
                      undefined,
                      host,
                      options,
                    ),
                  },
                  index,
                  options,
                )
              : undefined;
            const resolved = ts.resolveModuleName(
              name,
              containingFile,
              options,
              host,
              undefined,
              undefined,
              mode,
            ).resolvedModule;
            return (
              resolved && { ...resolved, resolvedFileName: realpath(resolved.resolvedFileName) }
            );
          });
        },
      };
    },
  });
  for (const [path, text] of Object.entries(files)) {
    project.getFileSystem().writeFileSync(`/repo/${path}`, text);
  }
  project.addSourceFilesAtPaths('/repo/**/*.{ts,tsx,mts,cts}');
  return project;
}

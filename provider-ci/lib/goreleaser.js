import * as param from '@jkcfg/std/param';
const majVersion = param.Number('major-version', 2);
const skipTfGen = param.Boolean('skipTfGen', false);
const customLdFlag = param.String('customLdFlag') || "";
const skipWindowsArmBuild = param.Boolean('skipWindowsArmBuild', false);
export class GoreleaserConfig {
    constructor(params) {
        Object.assign(this, params);
    }
}
export class PulumiGoreleaserPreConfig extends GoreleaserConfig {
    constructor(name) {
        super();
        let ldflags;
        let ignores = [];
        if (skipWindowsArmBuild) {
            ignores.push({ goos: "windows", goarch: "arm64" });
        }
        if (majVersion > 1) {
            ldflags = [`-X github.com/pulumi/pulumi-${name}/provider/v${majVersion}/pkg/version.Version={{.Tag}}`];
        }
        else {
            ldflags = [`-X github.com/pulumi/pulumi-${name}/provider/pkg/version.Version={{.Tag}}`];
        }
        if (customLdFlag != "") {
            ldflags.push(customLdFlag);
        }
        if (!skipTfGen) {
            this.before = {
                hooks: [
                    'make tfgen'
                ]
            };
        }
        this.builds = [{
                dir: 'provider',
                env: [
                    'CGO_ENABLED=0',
                    'GO111MODULE=on'
                ],
                goos: [
                    'darwin',
                    'windows',
                    'linux',
                ],
                goarch: [
                    'amd64',
                    'arm64',
                ],
                ignore: ignores,
                main: `./cmd/pulumi-resource-${name}/`,
                ldflags: ldflags,
                binary: `pulumi-resource-${name}`
            }];
        this.archives = [{
                name_template: '{{ .Binary }}-{{ .Tag }}-{{ .Os }}-{{ .Arch }}',
                id: 'archive',
            }];
        this.snapshot = {
            name_template: '{{ .Tag }}-SNAPSHOT'
        };
        this.changelog = {
            skip: true,
        };
        this.release = {
            disable: true
        };
        this.blobs = [{
                provider: 's3',
                region: 'us-west-2',
                bucket: 'get.pulumi.com',
                folder: 'releases/plugins/',
                ids: ['archive']
            }];
    }
}
export class PulumiGoreleaserConfig extends PulumiGoreleaserPreConfig {
    constructor(name) {
        super(name);
        this.release = {
            disable: false
        };
        this.changelog = {
            use: 'git',
            sort: 'asc',
            filters: {
                exclude: [
                    "Merge branch",
                    "Merge pull request",
                    "[internal]",
                    "[ci]",
                    "[chore]",
                ],
            },
        };
    }
}

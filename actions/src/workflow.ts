import * as g from '@jaxxstorm/gh-actions';
import * as job from '@jaxxstorm/gh-actions/lib/job';
import * as param from '@jkcfg/std/param';

const provider = param.String('provider');
const extraEnv = param.Object('env');
const docker = param.Boolean('docker');
const setupScript = param.String('setup-script');

const env = Object.assign({
  // eslint-disable-next-line no-template-curly-in-string
  GITHUB_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
  GO111MODULE: 'on',
  PROVIDER: provider,
  // eslint-disable-next-line no-template-curly-in-string
  PULUMI_ACCESS_TOKEN: '${{ secrets.PULUMI_ACCESS_TOKEN }}',
  PULUMI_API: 'https://api.pulumi-staging.io',
  // eslint-disable-next-line no-template-curly-in-string
  PULUMI_LOCAL_NUGET: '${{ github.workspace }}/nuget',

}, extraEnv);

export class BaseJob extends job.Job {
  steps = [
    {
      name: 'Checkout Repo',
      uses: 'actions/checkout@v2',
    },
    {
      name: 'Checkout Scripts Repo',
      uses: 'actions/checkout@v2',
      with: {
        path: 'ci-scripts',
        repository: 'pulumi/scripts',
      },
    },
    {
      name: 'Unshallow clone for tags',
      run: 'git fetch --prune --unshallow',
    },
    {
      name: 'Install Go',
      uses: 'actions/setup-go@v2',
      with: {
        'go-version': '${{ matrix.goversion }}',
      },
    },
    {
      name: 'Install pulumictl',
      uses: 'jaxxstorm/action-install-gh-release@release/v1-alpha',
      with: {
        repo: 'pulumi/pulumictl',
      },
    },
    {
      name: 'Install Pulumi CLI',
      uses: 'pulumi/action-install-pulumi-cli@releases/v1',
    },
  ];
  'runs-on' = 'ubuntu-latest'

  constructor(name: string, params?: Partial<BaseJob>) {
    super();
    this.name = name;
    Object.assign(this, {name}, params)
  }
  addStep(step) {
    this.steps.push(step);
    return this;
  }
  addDocker(docker) {
    if (docker) {
      this.steps.push({
        name: 'Run docker-compose',
        run: 'docker-compose -f testing/docker-compose.yml up --build -d'
      })
    }
    return this;
  }
  addSetupScript(setupScript) {
    if (setupScript) {
      this.steps.push({
        name: 'Run setup script',
        run: `${setupScript}`,
      })
    }
    return this;
  }
}

export class MultilangJob extends BaseJob {
  strategy = {
    'fail-fast': true,
    matrix: {
      language: ['nodejs', 'python', 'dotnet', 'go'],
      goversion: ['1.14.x'], // FIXME make this configurable
      dotnetversion: ['3.1.201'],
      pythonversion: ['3.7'],
      nodeversion: ['13.x'],
    },
  };
  steps = this.steps.concat([
    {
      name: 'Setup Node',
      uses: 'actions/setup-node@v1',
      with: {
        'node-version': '${{matrix.nodeversion}}',
        'registry-url': 'https://registry.npmjs.org',
      },
    },
    {
      name: 'Setup DotNet',
      uses: 'actions/setup-dotnet@v1',
      with: {
        'dotnet-version': '${{matrix.dotnetverson}}',
      },
    },
    {
      name: 'Setup Python',
      uses: 'actions/setup-python@v1',
      with: {
        'python-version': '${{matrix.pythonversion}}',
      },
    },
    {
      name: 'Download provider + tfgen binaries',
      uses: 'actions/download-artifact@v2',
      with: {
        // eslint-disable-next-line no-template-curly-in-string
        name: 'pulumi-${{ env.PROVIDER }}',
        // eslint-disable-next-line no-template-curly-in-string
        path: '${{ github.workspace }}/bin',
      },
    },
    {
      name: 'Restore binary perms',
      // eslint-disable-next-line no-template-curly-in-string
      run: 'find ${{ github.workspace }} -name "pulumi-*-${{ env.PROVIDER }}" -print -exec chmod +x {} \\;',
    },
  ]);
}

export class PulumiBaseWorkflow extends g.GithubWorkflow {
  jobs: {[k: string]: job.Job}

  constructor(name: string, jobs: {[k: string]: job.Job}) {
    super(name, jobs, {
      push: { branches: ['master'] },
      pull_request: { branches: ['master'] },
    }, {
      env,
    });

    this.jobs = {
      lint: new BaseJob('lint', {
        container: 'golangci/golangci-lint:v1.25.1'
      })
        .addStep(
          {
            name: 'Run golangci',
            run: 'make -f Makefile.github lint_provider',
          },
        ),
      prerequisites: new BaseJob('prerequisites')
        .addStep(
          {
            name: 'Build tfgen & provider binaries',
            run: 'make -f Makefile.github provider',
          },
        )
        .addStep(
          {
            name: 'Upload artifacts',
            uses: 'actions/upload-artifact@v2',
            with: {
              // eslint-disable-next-line no-template-curly-in-string
              name: 'pulumi-${{ env.PROVIDER }}',
              // eslint-disable-next-line no-template-curly-in-string
              path: '${{ github.workspace }}/bin',
            },
          },
        ),
      build_sdk: new MultilangJob('build_sdk', {
        needs: 'prerequisites'})
        .addStep({
          name: 'Build SDK',
          // eslint-disable-next-line no-template-curly-in-string
          run: 'make -f Makefile.github build_${{ matrix.language }}',
        })
        .addStep({
          name: 'Check worktree clean',
          run: './ci-scripts/ci/check-worktree-is-clean',
        })
        .addStep({
          name: 'Upload artifacts',
          uses: 'actions/upload-artifact@v2',
          with: {
            // eslint-disable-next-line no-template-curly-in-string
            name: '${{ matrix.language  }}-sdk',
            // eslint-disable-next-line no-template-curly-in-string
            path: '${{ github.workspace}}/sdk/${{ matrix.language }}',
          },
        }),
      lint_sdk: new BaseJob('lint-sdk', {
        container: 'golangci/golangci-lint:v1.25.1',
        needs: 'build_sdk'
      })
        .addStep(
            {
              name: 'Run golangci',
              run: 'cd sdk/go/' + provider + " && golangci-lint run -c ../../../.golangci.yml",
            },
        ),
      test: new MultilangJob('test', { needs: 'build_sdk'})
        .addStep({
          name: 'Download SDK',
          uses: 'actions/download-artifact@v2',
          with: {
            // eslint-disable-next-line no-template-curly-in-string
            name: '${{ matrix.language  }}-sdk',
            // eslint-disable-next-line no-template-curly-in-string
            path: '${{ github.workspace}}/sdk/${{ matrix.language }}',
          },
        })
        .addStep({
          name: 'Update path',
          // eslint-disable-next-line no-template-curly-in-string
          run: 'echo ::add-path::${{ github.workspace }}/bin',
        })
        .addStep({
          name: 'Install pipenv',
          uses: 'dschep/install-pipenv-action@v1',
        })
        .addStep({
          name: 'Install dependencies',
          // eslint-disable-next-line no-template-curly-in-string
          run: 'make -f Makefile.github install_${{ matrix.language}}_sdk',
        })
        .addDocker(docker)
        .addSetupScript(setupScript)
        .addStep({
          name: 'Run tests',
          // eslint-disable-next-line no-template-curly-in-string
          run: 'cd examples && go test -v -count=1 -cover -timeout 2h -tags=${{ matrix.language }} -parallel 4 .',
        }),
    };
  }
}

export class PulumiReleaseWorkflow extends PulumiBaseWorkflow {
  constructor(name: string, jobs: {[k: string]: job.Job}) {
    super(name, jobs);
    this.jobs = Object.assign(this.jobs, {
      publish: {
        needs: 'build_sdk',
        steps: [
          {
            name: 'Checkout Repo',
            uses: 'actions/checkout@v2',
          },
          {
            name: 'Checkout Scripts Repo',
            uses: 'actions/checkout@v2',
            with: {
              path: 'ci-scripts',
              repository: 'pulumi/scripts',
            },
          },
          {
            name: 'Configure AWS Credentials',
            uses: 'aws-actions/configure-aws-credentials@v1',
            with: {
              // eslint-disable-next-line no-template-curly-in-string
              'aws-access-key-id': '${{ secrets.AWS_ACCESS_KEY_ID }}',
              'aws-region': 'us-east-2',
              // eslint-disable-next-line no-template-curly-in-string
              'aws-secret-access-key': '${{ secrets.AWS_SECRET_ACCESS_KEY }}',
              'role-duration-seconds': 3600,
              'role-external-id': 'upload-pulumi-release',
              // eslint-disable-next-line no-template-curly-in-string
              'role-session-name': '${{ env.PROVIDER}}@githubActions',
              // eslint-disable-next-line no-template-curly-in-string
              'role-to-assume': '${{ secrets.AWS_UPLOAD_ROLE_ARN }}',
            },
          },
          {
            name: 'Setup Go',
            uses: 'actions/setup-go@v2',
            with: {
              'go-version': '${{ matrix.goversion }}',
            },
          },
          {
            name: 'Run GoReleaser',
            uses: 'goreleaser/goreleaser-action@v2',
            with: {
              args: 'release --rm-dist',
              version: 'latest',
            },
          },
        ],
      },
    });
  }
  on = {
    push: { tags: ['v*.*.*'] },
  }
}

export class PulumiPreReleaseWorkflow extends PulumiBaseWorkflow {
  constructor(name: string, jobs: {[k: string]: job.Job}) {
    super(name, jobs);
    this.jobs = Object.assign(this.jobs, {
      publish: {
        needs: 'build_sdk',
        steps: [
          {
            name: 'Checkout Repo',
            uses: 'actions/checkout@v2',
          },
          {
            name: 'Checkout Scripts Repo',
            uses: 'actions/checkout@v2',
            with: {
              path: 'ci-scripts',
              repository: 'pulumi/scripts',
            },
          },
          {
            name: 'Configure AWS Credentials',
            uses: 'aws-actions/configure-aws-credentials@v1',
            with: {
              // eslint-disable-next-line no-template-curly-in-string
              'aws-access-key-id': '${{ secrets.AWS_ACCESS_KEY_ID }}',
              'aws-region': 'us-east-2',
              // eslint-disable-next-line no-template-curly-in-string
              'aws-secret-access-key': '${{ secrets.AWS_SECRET_ACCESS_KEY }}',
              'role-duration-seconds': '3600',
              'role-external-id': 'upload-pulumi-release',
              // eslint-disable-next-line no-template-curly-in-string
              'role-session-name': '${{ env.PROVIDER}}@githubActions',
              // eslint-disable-next-line no-template-curly-in-string
              'role-to-assume': '${{ secrets.AWS_UPLOAD_ROLE_ARN }}',
            },
          },
          {
            name: 'Setup Go',
            uses: 'actions/setup-go@v2',
            with: {
              'go-version': '${{ matrix.goversion }}',
            },
          },
          {
            name: 'Run GoReleaser',
            uses: 'goreleaser/goreleaser-action@v2',
            with: {
              args: 'release --rm-dist --config=.goreleaser.prerelease.yaml',
              version: 'latest',
            },
          },
        ],
      },
    });
  }
  on = {
    push: { tags: ['v*.*.*-**'] },
  }
}

# cdk-hybrid-esm-lambda

CDK app that deploys a Lambda function from a hybrid ESM bundle.

## Optimizing Node.js Lambda: A Hybrid ESM Approach

This repository demonstrates a hybrid approach to optimize Node.js Lambda functions by leveraging the advantages of ES modules (ESM) for size and performance improvements, while maintaining compatibility with existing CommonJS (CJS) codebases.

**The Dilemma:** Transitioning a CDK project entirely to ESM can be a daunting task, often hindered by dependencies on older CJS libraries and the complexities of updating project configurations. This typically involves modifications to `tsconfig.json`, `package.json`, and `cdk.json` files, which can be time-consuming and error-prone.

**The Hybrid Approach:** By leveraging the AWS CDK's [NodejsFunction](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_lambda_nodejs.NodejsFunction.html) construct and its built-in `esbuild` bundling capabilities, we can create Lambda functions that prioritize ESM modules while gracefully falling back to CJS when needed. This enables us to achieve the following benefits::

- **Significant Size Reduction:** Witness dramatic reductions in package size compared to traditional CJS bundling, thanks to ESM features like tree-shaking, which eliminates unused code. For instance, in the provided example, a CJS bundle reduces [from 2.9 MB to 1.3 MB](./src/assets/cjs-bundle.png), while the hybrid ESM approach achieves an even more impressive reduction [from 2.5 MB to a mere 585 KB](./src/assets/esm-bundle.png).
- **Faster Cold Starts:** Smaller package size directly translates to faster Lambda initialization and significantly reduced cold start latency, improving the responsiveness and efficiency of your serverless applications.
- **Enhanced Runtime Efficiency:** ESM, with its support for top-level await and asynchronous module loading, can improve how your code executes and utilizes resources during runtime compared to CJS.

**Key Benefits:**

- **Minimal Effort:** No need to refactor your existing CJS codebase, saving you time and effort.
- **Reduced Complexity:** Avoid the intricacies of configuring your project for full ESM adoption.
- **Optimized Lambda Functions:** Achieve smaller package sizes and faster cold starts without sacrificing compatibility.

**Implementation Details:**

The provided example showcases how to configure the CDK's `NodejsFunction` construct with specific bundling options to achieve this hybrid approach. Key properties include:

- `format`: Sets the output format to ESM for optimal bundling.
- `mainFields`: Specifies the order in which module formats are resolved, prioritizing ESM.
- `banner`: Includes a code snippet to ensure seamless compatibility with CJS modules.

**This hybrid solution offers the best of both worlds: it unlocks ESM's size and performance benefits for your Lambda functions, while ensuring seamless integration with your existing CJS codebase, all without requiring a full migration.**

## Prerequisites

- **_AWS:_**
  - Must have authenticated with [Default Credentials](https://docs.aws.amazon.com/cdk/v2/guide/cli.html#cli_auth) in your local environment.
  - Must have completed the [CDK bootstrapping](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html) for the target AWS environment.
- **_mise:_**
  - [Install mise](https://mise.jdx.dev/installing-mise.html), which manages the required toolchain.

## Installation

```sh
mise install
pnpm install
```

## Deployment

```sh
pnpm run deploy
```

## Cleanup

```sh
pnpm destroy
```

## Architecture Diagram

![Architecture Diagram](./src/assets/arch.svg)

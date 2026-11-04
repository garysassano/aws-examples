import { setTimeout as sleep } from "node:timers/promises";
import {
  BatchGetBuildsCommand,
  CodeBuildClient,
  StartBuildCommand,
} from "@aws-sdk/client-codebuild";
import { IMAGE_BUILDER_PROJECT, REGION } from "../constants.js";

const codebuild = new CodeBuildClient({ region: REGION });

const { build } = await codebuild.send(
  new StartBuildCommand({ projectName: IMAGE_BUILDER_PROJECT }),
);
console.log(`Started ${build?.id}. The image takes about 5 minutes to build and index.`);

while (true) {
  await sleep(15_000);
  const { builds } = await codebuild.send(new BatchGetBuildsCommand({ ids: [build?.id ?? ""] }));
  const status = builds?.[0]?.buildStatus;
  if (status === "IN_PROGRESS") continue;
  if (status !== "SUCCEEDED") throw new Error(`Image build ended with ${status}`);
  console.log("Image pushed with both tags.");
  break;
}

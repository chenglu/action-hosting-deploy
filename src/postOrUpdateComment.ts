/**
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { endGroup, startGroup } from "@actions/core";
import type { GitHub } from "@actions/github/lib/utils";
import { Context } from "@actions/github/lib/context";
import {
  ChannelSuccessResult,
  interpretChannelDeployResult,
  ErrorResult,
} from "./deploy";
import { createDeploySignature } from "./hash";
import { getInput } from "@actions/core";
import { Octokit } from "@octokit/rest";
import { context, getOctokit } from "@actions/github";

// Get inputs from workflow file
const showDetailedUrls = getInput("showDetailedUrls");
const fileExtension = getInput("fileExtension") || "md, html";
const originalPath = getInput("originalPath") || "_site/";
const replacedPath = getInput("replacedPath") || "/";


const pullRequest = context.payload.pull_request;
const pullRequestNumber = pullRequest.number;

const BOT_SIGNATURE = "showDetailedUrls: " + showDetailedUrls + "\n" + "pullRequestNumber: " 
                      + pullRequestNumber + "\n" + "getChangedFilesByPullRequestNumber";

export async function getChangedFilesByPullRequestNumber(pullRequestNumber: number): Promise<string[]> {
  const token = process.env.GITHUB_TOKEN || getInput("repoToken");
  const octokit = token ? getOctokit(token) : undefined;
  const { data: files } = await octokit.rest.pulls.listFiles({
    ...context.repo,
    pull_number: pullRequestNumber,
  });
  const fileExtensions = fileExtension.split(",").map((ext) => ext.trim());  // 过滤空格
  const prChangedFiles = files
    .filter((file) => {
      const extension = file.filename.split(".").pop();
      return fileExtensions.includes(extension);
    })
    .map((file) => file.filename);

  const replacedPathRegex = new RegExp(`^${originalPath}`);
  const prChangedFilesWithCustomizedPath = prChangedFiles.map((filePath) => {
    return filePath.replace(replacedPathRegex, replacedPath);
  });

  return prChangedFilesWithCustomizedPath;
}

// changedFilesMarkdown = getChangedFilesMarkdown(pullRequestNumber);

export function createBotCommentIdentifier(signature: string) {
  return function isCommentByBot(comment): boolean {
    return comment.user.type === "Bot" && comment.body.includes(signature);
  };
}

export function getURLsMarkdownFromChannelDeployResult(
  result: ChannelSuccessResult
): string {
  const { urls } = interpretChannelDeployResult(result);

  return urls.length === 1
    ? `[${urls[0]}](${urls[0]})`
    : urls.map((url) => `- [${url}](${url})`).join("\n");
}

export function getURLsFromChannelDeployResult(
  result: ChannelSuccessResult
): string[] {
  const { urls } = interpretChannelDeployResult(result);
  return urls;
}

export function getChannelDeploySuccessComment(
  result: ChannelSuccessResult,
  commit: string,
  changedFilesMarkdown: string[]
) {
  const deploySignature = createDeploySignature(result);
  const urlList = getURLsFromChannelDeployResult(result);
  const { expireTime } = interpretChannelDeployResult(result);

  const changedFilesWithUrls = changedFilesMarkdown.map((file) => {
    return `${urlList}${file}`;
  }).join("\n");

  return `
Visit the preview URL for this PR (updated for commit ${commit}):

${urlList}

### Changed Details:
${changedFilesWithUrls}

<sub>(expires ${new Date(expireTime).toUTCString()})</sub>

${BOT_SIGNATURE}

<sub>Sign: ${deploySignature}</sub>`.trim();
}

export async function postChannelSuccessComment(
  github: InstanceType<typeof GitHub>,
  context: Context,
  result: ChannelSuccessResult,
  commit: string,
  // changedFilesMarkdown: string  // 新增参数
) {
  const commentInfo = {
    ...context.repo,
    issue_number: context.issue.number,
  };

  const fileChanges = await getChangedFilesByPullRequestNumber(pullRequestNumber);
 // export fileChanges to markdown
  // const changedFilesMarkdown = fileChanges.map((file) => `- ${file}`).join("\n");

  const commentMarkdown = getChannelDeploySuccessComment(result, commit, fileChanges);

  const comment = {
    ...commentInfo,
    body: commentMarkdown,
  };

  startGroup(`Commenting on PR`);
  const deploySignature = createDeploySignature(result);
  const isCommentByBot = createBotCommentIdentifier(deploySignature);

  let commentId;
  try {
    const comments = (await github.rest.issues.listComments(commentInfo)).data;
    for (let i = comments.length; i--; ) {
      const c = comments[i];
      if (isCommentByBot(c)) {
        commentId = c.id;
        break;
      }
    }
  } catch (e) {
    console.log("Error checking for previous comments: " + e.message);
  }

  if (commentId) {
    try {
      await github.rest.issues.updateComment({
        ...context.repo,
        comment_id: commentId,
        body: comment.body,
      });
    } catch (e) {
      commentId = null;
    }
  }

  if (!commentId) {
    try {
      await github.rest.issues.createComment(comment);
    } catch (e) {
      console.log(`Error creating comment: ${e.message}`);
    }
  }
  endGroup();
}

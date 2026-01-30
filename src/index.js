import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;

// GitHub token from environment variable - read dynamically
function getGithubToken() {
  return process.env.GITHUB_TOKEN || '';
}

// ============================================
// LOGGING UTILITIES
// ============================================

function logToolCall(toolName, args, sessionId = 'unknown') {
  const timestamp = new Date().toISOString();
  const sanitizedArgs = sanitizeArgs(args);
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`📥 TOOL CALL: ${toolName}`);
  console.log(`${'─'.repeat(70)}`);
  console.log(`⏰ Time: ${timestamp}`);
  console.log(`🔑 Session: ${sessionId}`);
  console.log(`📝 Arguments: ${JSON.stringify(sanitizedArgs, null, 2)}`);
}

function logToolResult(toolName, result, duration, isError = false) {
  const icon = isError ? '❌' : '✅';
  const status = isError ? 'ERROR' : 'SUCCESS';
  console.log(`${'─'.repeat(70)}`);
  console.log(`${icon} Result: ${status} (${duration}ms)`);
  if (isError) {
    console.log(`💥 Error: ${result}`);
  } else {
    const preview = JSON.stringify(result).substring(0, 500);
    console.log(`📤 Response: ${preview}${preview.length >= 500 ? '...' : ''}`);
  }
  console.log(`${'═'.repeat(70)}\n`);
}

function sanitizeArgs(args) {
  if (!args) return args;
  const sanitized = { ...args };
  // Hide sensitive content but show structure
  if (sanitized.content && sanitized.content.length > 200) {
    sanitized.content = `[${sanitized.content.length} chars]`;
  }
  if (sanitized.token) sanitized.token = '[REDACTED]';
  if (sanitized.password) sanitized.password = '[REDACTED]';
  return sanitized;
}

// GitHub API configuration
const GITHUB_API_URL = 'https://api.github.com';

// ============================================
// GITHUB API FUNCTIONS
// ============================================

async function githubRequest(endpoint, method = 'GET', body = null) {
  const githubToken = getGithubToken();
  if (!githubToken) {
    throw new Error('GITHUB_TOKEN environment variable is not set');
  }

  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${githubToken}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  };
  if (body) {
    options.body = JSON.stringify(body);
  }
  const response = await fetch(`${GITHUB_API_URL}${endpoint}`, options);

  if (response.status === 204) {
    return { success: true };
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(error.message || `GitHub API error: ${response.status}`);
  }

  return response.json();
}

async function githubGetUser() {
  return githubRequest('/user');
}

async function githubVerifyToken() {
  try {
    const user = await githubGetUser();
    return {
      valid: true,
      user: {
        login: user.login,
        name: user.name,
        email: user.email,
        avatar_url: user.avatar_url
      }
    };
  } catch (error) {
    return { valid: false, error: error.message };
  }
}

async function githubListRepositories(sort = 'updated', perPage = 30) {
  return githubRequest(`/user/repos?sort=${sort}&per_page=${perPage}`);
}

async function githubGetRepository(owner, repo) {
  return githubRequest(`/repos/${owner}/${repo}`);
}

async function githubCreateRepository(name, description = '', isPrivate = false, autoInit = true) {
  return githubRequest('/user/repos', 'POST', {
    name,
    description,
    private: isPrivate,
    auto_init: autoInit
  });
}

async function githubDeleteRepository(owner, repo) {
  return githubRequest(`/repos/${owner}/${repo}`, 'DELETE');
}

async function githubGetFileContents(owner, repo, path, ref = 'main') {
  const data = await githubRequest(`/repos/${owner}/${repo}/contents/${path}?ref=${ref}`);
  if (data.content && data.encoding === 'base64') {
    data.decodedContent = Buffer.from(data.content, 'base64').toString('utf-8');
  }
  return data;
}

async function githubCreateOrUpdateFile(owner, repo, path, content, message, branch = 'main', sha = null) {
  const body = {
    message,
    content: Buffer.from(content).toString('base64'),
    branch
  };
  if (sha) {
    body.sha = sha;
  }
  return githubRequest(`/repos/${owner}/${repo}/contents/${path}`, 'PUT', body);
}

async function githubDeleteFile(owner, repo, path, message, sha, branch = 'main') {
  return githubRequest(`/repos/${owner}/${repo}/contents/${path}`, 'DELETE', {
    message,
    sha,
    branch
  });
}

async function githubPushFiles(owner, repo, files, message, branch = 'main') {
  const refData = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${branch}`);
  const currentCommitSha = refData.object.sha;

  const commitData = await githubRequest(`/repos/${owner}/${repo}/git/commits/${currentCommitSha}`);
  const baseTreeSha = commitData.tree.sha;

  const treeItems = await Promise.all(
    files.map(async (file) => {
      const blobData = await githubRequest(`/repos/${owner}/${repo}/git/blobs`, 'POST', {
        content: file.content,
        encoding: 'utf-8'
      });
      return {
        path: file.path,
        mode: '100644',
        type: 'blob',
        sha: blobData.sha
      };
    })
  );

  const newTree = await githubRequest(`/repos/${owner}/${repo}/git/trees`, 'POST', {
    base_tree: baseTreeSha,
    tree: treeItems
  });

  const newCommit = await githubRequest(`/repos/${owner}/${repo}/git/commits`, 'POST', {
    message,
    tree: newTree.sha,
    parents: [currentCommitSha]
  });

  await githubRequest(`/repos/${owner}/${repo}/git/refs/heads/${branch}`, 'PATCH', {
    sha: newCommit.sha
  });

  return {
    commit: newCommit,
    filesUpdated: files.length
  };
}

async function githubListBranches(owner, repo) {
  return githubRequest(`/repos/${owner}/${repo}/branches`);
}

async function githubGetBranch(owner, repo, branch) {
  return githubRequest(`/repos/${owner}/${repo}/branches/${branch}`);
}

async function githubCreateBranch(owner, repo, branchName, fromBranch = 'main') {
  const sourceBranch = await githubGetBranch(owner, repo, fromBranch);
  const sha = sourceBranch.commit.sha;
  return githubRequest(`/repos/${owner}/${repo}/git/refs`, 'POST', {
    ref: `refs/heads/${branchName}`,
    sha
  });
}

async function githubDeleteBranch(owner, repo, branch) {
  return githubRequest(`/repos/${owner}/${repo}/git/refs/heads/${branch}`, 'DELETE');
}

async function githubListCommits(owner, repo, branch = 'main', perPage = 30) {
  return githubRequest(`/repos/${owner}/${repo}/commits?sha=${branch}&per_page=${perPage}`);
}

async function githubGetCommit(owner, repo, sha) {
  return githubRequest(`/repos/${owner}/${repo}/commits/${sha}`);
}

async function githubCreatePullRequest(owner, repo, title, head, base, body = '', draft = false) {
  return githubRequest(`/repos/${owner}/${repo}/pulls`, 'POST', {
    title,
    head,
    base,
    body,
    draft
  });
}

async function githubListPullRequests(owner, repo, state = 'open', perPage = 30) {
  return githubRequest(`/repos/${owner}/${repo}/pulls?state=${state}&per_page=${perPage}`);
}

async function githubGetPullRequest(owner, repo, pullNumber) {
  return githubRequest(`/repos/${owner}/${repo}/pulls/${pullNumber}`);
}

async function githubMergePullRequest(owner, repo, pullNumber, commitTitle = '', commitMessage = '', mergeMethod = 'merge') {
  return githubRequest(`/repos/${owner}/${repo}/pulls/${pullNumber}/merge`, 'PUT', {
    commit_title: commitTitle,
    commit_message: commitMessage,
    merge_method: mergeMethod
  });
}

async function githubCreateIssue(owner, repo, title, body = '', labels = [], assignees = []) {
  return githubRequest(`/repos/${owner}/${repo}/issues`, 'POST', {
    title,
    body,
    labels,
    assignees
  });
}

async function githubListIssues(owner, repo, state = 'open', perPage = 30) {
  return githubRequest(`/repos/${owner}/${repo}/issues?state=${state}&per_page=${perPage}`);
}

async function githubAddComment(owner, repo, issueNumber, body) {
  return githubRequest(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, 'POST', { body });
}

async function githubGetTree(owner, repo, sha = 'main', recursive = true) {
  const params = recursive ? '?recursive=1' : '';
  return githubRequest(`/repos/${owner}/${repo}/git/trees/${sha}${params}`);
}

async function githubListContents(owner, repo, path = '', ref = 'main') {
  const endpoint = path
    ? `/repos/${owner}/${repo}/contents/${path}?ref=${ref}`
    : `/repos/${owner}/${repo}/contents?ref=${ref}`;
  return githubRequest(endpoint);
}

async function githubSearchRepositories(query, sort = 'stars', order = 'desc', perPage = 10) {
  const params = new URLSearchParams({
    q: query,
    sort,
    order,
    per_page: perPage.toString()
  });
  return githubRequest(`/search/repositories?${params}`);
}

async function githubSearchCode(query, perPage = 30) {
  const params = new URLSearchParams({
    q: query,
    per_page: perPage.toString()
  });
  return githubRequest(`/search/code?${params}`);
}

// ============================================
// MCP SERVER SETUP
// ============================================

function createMCPServer() {
  const server = new Server(
    { name: 'github-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'github_verify_token',
        description: 'Verify GitHub access token and get user info',
        inputSchema: { type: 'object', properties: {}, required: [] }
      },
      {
        name: 'github_get_user',
        description: 'Get authenticated GitHub user info',
        inputSchema: { type: 'object', properties: {}, required: [] }
      },
      {
        name: 'github_list_repositories',
        description: 'List repositories for the authenticated user',
        inputSchema: {
          type: 'object',
          properties: {
            sort: { type: 'string', description: 'Sort by: created, updated, pushed, full_name (default: updated)' },
            perPage: { type: 'number', description: 'Results per page (default: 30)' }
          },
          required: []
        }
      },
      {
        name: 'github_get_repository',
        description: 'Get repository details',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' }
          },
          required: ['owner', 'repo']
        }
      },
      {
        name: 'github_create_repository',
        description: 'Create a new GitHub repository',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Repository name' },
            description: { type: 'string', description: 'Repository description' },
            isPrivate: { type: 'boolean', description: 'Make repository private (default: false)' },
            autoInit: { type: 'boolean', description: 'Initialize with README (default: true)' }
          },
          required: ['name']
        }
      },
      {
        name: 'github_delete_repository',
        description: 'Delete a GitHub repository',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' }
          },
          required: ['owner', 'repo']
        }
      },
      {
        name: 'github_get_file_contents',
        description: 'Get contents of a file from a repository',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            path: { type: 'string', description: 'File path' },
            ref: { type: 'string', description: 'Branch or commit (default: main)' }
          },
          required: ['owner', 'repo', 'path']
        }
      },
      {
        name: 'github_create_or_update_file',
        description: 'Create or update a file in a repository',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            path: { type: 'string', description: 'File path' },
            content: { type: 'string', description: 'File content' },
            message: { type: 'string', description: 'Commit message' },
            branch: { type: 'string', description: 'Branch name (default: main)' },
            sha: { type: 'string', description: 'SHA of file to update (required for updates)' }
          },
          required: ['owner', 'repo', 'path', 'content', 'message']
        }
      },
      {
        name: 'github_delete_file',
        description: 'Delete a file from a repository',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            path: { type: 'string', description: 'File path' },
            message: { type: 'string', description: 'Commit message' },
            sha: { type: 'string', description: 'SHA of file to delete' },
            branch: { type: 'string', description: 'Branch name (default: main)' }
          },
          required: ['owner', 'repo', 'path', 'message', 'sha']
        }
      },
      {
        name: 'github_push_files',
        description: 'Push multiple files in a single commit using Git Data API',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            files: {
              type: 'array',
              description: 'Array of files to push',
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string', description: 'File path' },
                  content: { type: 'string', description: 'File content' }
                },
                required: ['path', 'content']
              }
            },
            message: { type: 'string', description: 'Commit message' },
            branch: { type: 'string', description: 'Branch name (default: main)' }
          },
          required: ['owner', 'repo', 'files', 'message']
        }
      },
      {
        name: 'github_list_branches',
        description: 'List branches in a repository',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' }
          },
          required: ['owner', 'repo']
        }
      },
      {
        name: 'github_create_branch',
        description: 'Create a new branch',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            branchName: { type: 'string', description: 'New branch name' },
            fromBranch: { type: 'string', description: 'Source branch (default: main)' }
          },
          required: ['owner', 'repo', 'branchName']
        }
      },
      {
        name: 'github_delete_branch',
        description: 'Delete a branch',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            branch: { type: 'string', description: 'Branch name to delete' }
          },
          required: ['owner', 'repo', 'branch']
        }
      },
      {
        name: 'github_list_commits',
        description: 'List commits in a repository',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            branch: { type: 'string', description: 'Branch name (default: main)' },
            perPage: { type: 'number', description: 'Results per page (default: 30)' }
          },
          required: ['owner', 'repo']
        }
      },
      {
        name: 'github_get_commit',
        description: 'Get a specific commit',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            sha: { type: 'string', description: 'Commit SHA' }
          },
          required: ['owner', 'repo', 'sha']
        }
      },
      {
        name: 'github_create_pull_request',
        description: 'Create a pull request',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            title: { type: 'string', description: 'PR title' },
            head: { type: 'string', description: 'Source branch' },
            base: { type: 'string', description: 'Target branch' },
            body: { type: 'string', description: 'PR description' },
            draft: { type: 'boolean', description: 'Create as draft (default: false)' }
          },
          required: ['owner', 'repo', 'title', 'head', 'base']
        }
      },
      {
        name: 'github_list_pull_requests',
        description: 'List pull requests',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            state: { type: 'string', description: 'State: open, closed, all (default: open)' },
            perPage: { type: 'number', description: 'Results per page (default: 30)' }
          },
          required: ['owner', 'repo']
        }
      },
      {
        name: 'github_get_pull_request',
        description: 'Get a specific pull request',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            pullNumber: { type: 'number', description: 'Pull request number' }
          },
          required: ['owner', 'repo', 'pullNumber']
        }
      },
      {
        name: 'github_merge_pull_request',
        description: 'Merge a pull request',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            pullNumber: { type: 'number', description: 'Pull request number' },
            commitTitle: { type: 'string', description: 'Merge commit title' },
            commitMessage: { type: 'string', description: 'Merge commit message' },
            mergeMethod: { type: 'string', description: 'Merge method: merge, squash, rebase (default: merge)' }
          },
          required: ['owner', 'repo', 'pullNumber']
        }
      },
      {
        name: 'github_create_issue',
        description: 'Create an issue',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            title: { type: 'string', description: 'Issue title' },
            body: { type: 'string', description: 'Issue body' },
            labels: { type: 'array', items: { type: 'string' }, description: 'Labels' },
            assignees: { type: 'array', items: { type: 'string' }, description: 'Assignees' }
          },
          required: ['owner', 'repo', 'title']
        }
      },
      {
        name: 'github_list_issues',
        description: 'List issues in a repository',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            state: { type: 'string', description: 'State: open, closed, all (default: open)' },
            perPage: { type: 'number', description: 'Results per page (default: 30)' }
          },
          required: ['owner', 'repo']
        }
      },
      {
        name: 'github_add_comment',
        description: 'Add a comment to an issue or PR',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            issueNumber: { type: 'number', description: 'Issue or PR number' },
            body: { type: 'string', description: 'Comment body' }
          },
          required: ['owner', 'repo', 'issueNumber', 'body']
        }
      },
      {
        name: 'github_get_tree',
        description: 'Get repository tree (directory structure)',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            sha: { type: 'string', description: 'Tree SHA or branch (default: main)' },
            recursive: { type: 'boolean', description: 'Get tree recursively (default: true)' }
          },
          required: ['owner', 'repo']
        }
      },
      {
        name: 'github_list_contents',
        description: 'List directory contents',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            path: { type: 'string', description: 'Directory path (default: root)' },
            ref: { type: 'string', description: 'Branch or commit (default: main)' }
          },
          required: ['owner', 'repo']
        }
      },
      {
        name: 'github_search_repositories',
        description: 'Search GitHub repositories',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            sort: { type: 'string', description: 'Sort by: stars, forks, updated (default: stars)' },
            order: { type: 'string', description: 'Order: asc, desc (default: desc)' },
            perPage: { type: 'number', description: 'Results per page (default: 10)' }
          },
          required: ['query']
        }
      },
      {
        name: 'github_search_code',
        description: 'Search code across repositories',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            perPage: { type: 'number', description: 'Results per page (default: 30)' }
          },
          required: ['query']
        }
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const startTime = Date.now();

    // Log the incoming tool call
    logToolCall(name, args);

    try {
      let result;

      switch (name) {
        case 'github_verify_token':
          result = await githubVerifyToken();
          break;
        case 'github_get_user':
          result = await githubGetUser();
          break;
        case 'github_list_repositories':
          result = await githubListRepositories(args.sort, args.perPage);
          break;
        case 'github_get_repository':
          result = await githubGetRepository(args.owner, args.repo);
          break;
        case 'github_create_repository':
          result = await githubCreateRepository(args.name, args.description, args.isPrivate, args.autoInit);
          break;
        case 'github_delete_repository':
          result = await githubDeleteRepository(args.owner, args.repo);
          break;
        case 'github_get_file_contents':
          result = await githubGetFileContents(args.owner, args.repo, args.path, args.ref);
          break;
        case 'github_create_or_update_file':
          result = await githubCreateOrUpdateFile(args.owner, args.repo, args.path, args.content, args.message, args.branch, args.sha);
          break;
        case 'github_delete_file':
          result = await githubDeleteFile(args.owner, args.repo, args.path, args.message, args.sha, args.branch);
          break;
        case 'github_push_files':
          result = await githubPushFiles(args.owner, args.repo, args.files, args.message, args.branch);
          break;
        case 'github_list_branches':
          result = await githubListBranches(args.owner, args.repo);
          break;
        case 'github_create_branch':
          result = await githubCreateBranch(args.owner, args.repo, args.branchName, args.fromBranch);
          break;
        case 'github_delete_branch':
          result = await githubDeleteBranch(args.owner, args.repo, args.branch);
          break;
        case 'github_list_commits':
          result = await githubListCommits(args.owner, args.repo, args.branch, args.perPage);
          break;
        case 'github_get_commit':
          result = await githubGetCommit(args.owner, args.repo, args.sha);
          break;
        case 'github_create_pull_request':
          result = await githubCreatePullRequest(args.owner, args.repo, args.title, args.head, args.base, args.body, args.draft);
          break;
        case 'github_list_pull_requests':
          result = await githubListPullRequests(args.owner, args.repo, args.state, args.perPage);
          break;
        case 'github_get_pull_request':
          result = await githubGetPullRequest(args.owner, args.repo, args.pullNumber);
          break;
        case 'github_merge_pull_request':
          result = await githubMergePullRequest(args.owner, args.repo, args.pullNumber, args.commitTitle, args.commitMessage, args.mergeMethod);
          break;
        case 'github_create_issue':
          result = await githubCreateIssue(args.owner, args.repo, args.title, args.body, args.labels, args.assignees);
          break;
        case 'github_list_issues':
          result = await githubListIssues(args.owner, args.repo, args.state, args.perPage);
          break;
        case 'github_add_comment':
          result = await githubAddComment(args.owner, args.repo, args.issueNumber, args.body);
          break;
        case 'github_get_tree':
          result = await githubGetTree(args.owner, args.repo, args.sha, args.recursive);
          break;
        case 'github_list_contents':
          result = await githubListContents(args.owner, args.repo, args.path, args.ref);
          break;
        case 'github_search_repositories':
          result = await githubSearchRepositories(args.query, args.sort, args.order, args.perPage);
          break;
        case 'github_search_code':
          result = await githubSearchCode(args.query, args.perPage);
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      // Log successful result
      const duration = Date.now() - startTime;
      logToolResult(name, result, duration);

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
      };
    } catch (error) {
      // Log error result
      const duration = Date.now() - startTime;
      logToolResult(name, error.message, duration, true);

      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true
      };
    }
  });

  return server;
}

// ============================================
// STREAMABLE HTTP TRANSPORT
// ============================================

const sessions = new Map();

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    tokenConfigured: !!getGithubToken()
  });
});

app.get('/mcp', (req, res) => {
  res.json({
    name: 'github-mcp',
    version: '1.0.0',
    description: 'MCP server for GitHub operations',
    transport: 'streamable-http',
    endpoint: '/mcp',
    tokenConfigured: !!getGithubToken(),
    tools: [
      'github_verify_token',
      'github_get_user',
      'github_list_repositories',
      'github_get_repository',
      'github_create_repository',
      'github_delete_repository',
      'github_get_file_contents',
      'github_create_or_update_file',
      'github_delete_file',
      'github_push_files',
      'github_list_branches',
      'github_create_branch',
      'github_delete_branch',
      'github_list_commits',
      'github_get_commit',
      'github_create_pull_request',
      'github_list_pull_requests',
      'github_get_pull_request',
      'github_merge_pull_request',
      'github_create_issue',
      'github_list_issues',
      'github_add_comment',
      'github_get_tree',
      'github_list_contents',
      'github_search_repositories',
      'github_search_code'
    ]
  });
});

app.post('/mcp', async (req, res) => {
  try {
    let sessionId = req.headers['mcp-session-id'];
    let transport;
    let server;

    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId);
      transport = session.transport;
      server = session.server;
    } else {
      sessionId = randomUUID();
      server = createMCPServer();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId,
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server });
        }
      });
      await server.connect(transport);
      sessions.set(sessionId, { transport, server });
    }

    res.setHeader('Mcp-Session-Id', sessionId);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('MCP error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/mcp', (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (sessionId && sessions.has(sessionId)) {
    sessions.delete(sessionId);
    res.status(200).json({ success: true });
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

app.listen(PORT, () => {
  console.log(`GitHub MCP Server running on port ${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`Token configured: ${!!GITHUB_TOKEN}`);
});

/* global module */
// Upsert the "Preview deploy ready" PR comment. Shared by both paths of
// preview-deploy.yml (full image deploy and frontend hot-sync) via
// actions/github-script: require('./.github/scripts/preview-comment.js').
module.exports = async function upsertPreviewComment({ github, context, sha, ttl, hotSynced }) {
  const pr = context.issue.number;
  const url = `https://pr-${pr}.greenhouse.madekivi.fi`;
  const how = hotSynced
    ? 'Frontend hot-synced into the running pod (no image rebuild) · '
    : '';
  const body = [
    '### Preview deploy ready',
    '',
    `🌐 ${url}`,
    '',
    `Commit: \`${sha.slice(0, 7)}\` · ${how}TTL: ${ttl}h (refreshed on every push) · ` +
    'Remove the `preview` label or close the PR to tear down immediately.',
    '',
    '<!-- preview-deploy-marker -->',
  ].join('\n');

  const { data: comments } = await github.rest.issues.listComments({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: pr,
    per_page: 100,
  });
  const existing = comments.find(c => c.body && c.body.includes('<!-- preview-deploy-marker -->'));
  if (existing) {
    await github.rest.issues.updateComment({
      owner: context.repo.owner, repo: context.repo.repo,
      comment_id: existing.id, body,
    });
  } else {
    await github.rest.issues.createComment({
      owner: context.repo.owner, repo: context.repo.repo,
      issue_number: pr, body,
    });
  }
};

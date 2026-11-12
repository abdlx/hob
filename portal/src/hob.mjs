// Called only by the loopback, owner-authenticated HOB provisioning endpoint.
export function provisionHobBot(store, slug, name = slug) {
  if (!store.workspaceRoot || !/^[a-z][a-z0-9_-]{0,63}$/.test(slug)) throw new Error('Invalid HOB profile');
  let profile = store.profileBySlug(slug);
  if (!profile) profile = store.createProfile({ slug, name: String(name).slice(0, 50) });
  store.ensureWorkspace(slug);
  let token = store.tokensForProfile(profile.id).find(t => !t.revoked && t.name === 'hob-managed');
  let plaintext = token && store.revealToken(token.id);
  if (!plaintext) ({ token, plaintext } = store.newBotToken(profile, 'hob-managed'));
  return { profile, plaintext, workspace: store.profileWorkspace(slug) };
}


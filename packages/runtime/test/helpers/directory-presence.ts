// The directory's answer to common_owner_authority for a fixture owner: the Telegram presence the request names, bound to
// the Durable Object the request names.
export const presenceAuthority = (ownerId: string, body: BodyInit | null | undefined): Response => {
  const asked = JSON.parse(String(body)) as { p_provider: string; p_subject: string; p_do_name: string };
  return Response.json({ owner_id: ownerId, auth_user_id: ownerId, do_name: asked.p_do_name, presence_id: '9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a',
    provider: asked.p_provider, subject: asked.p_subject, state_version: 1, admission_revision: '2' });
};

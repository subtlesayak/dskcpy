import assert from 'node:assert/strict';

// Handle the real browser modal only after the test intentionally clicks Stop.
// No global dialog auto-accept or production confirmation bypass is installed.
export async function confirmReceiverAction(page, { name = 'Disconnect', accept = true } = {}) {
  const pending = page.waitForEvent('dialog');
  const click = page.getByRole('button', { name, exact: true }).click();
  const dialog = await pending;
  assert.equal(dialog.type(), 'confirm');
  assert.match(dialog.message(), /Stop sharing|End presentation|Leave controller/);
  if (accept) await dialog.accept(); else await dialog.dismiss();
  await click;
}

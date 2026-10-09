// Capture the form before awaiting: DOM events clear currentTarget after dispatch.
export function createSettingsSubmitHandler({ save, refresh, notify, secretField, successMessage,
  readValues = (form) => Object.fromEntries(new FormData(form)),
}) {
  let pending = false;
  return async (event) => {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const secret = form.querySelector(`[name="${secretField}"]`);
    const buttons = [...form.querySelectorAll('button')];
    const previous = buttons.map((button) => button.disabled);
    pending = true;
    buttons.forEach((button) => { button.disabled = true; });
    let saved = false;
    try {
      await save(readValues(form));
      saved = true;
      secret.value = '';
      await refresh();
      notify(successMessage);
    } catch (error) {
      notify(saved ? `配置已保存，但页面刷新失败：${error.message}` : error.message, saved ? 'warn' : 'error');
    } finally {
      buttons.forEach((button, index) => { button.disabled = previous[index]; });
      pending = false;
    }
  };
}

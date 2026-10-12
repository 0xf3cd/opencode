import { action, useSubmission } from "@solidjs/router"
import { Resource } from "@opencode/console-resource"
import { Show } from "solid-js"
import { useI18n } from "~/context/i18n"
import { subscribeToNewsletter } from "~/lib/opensend"

const emailSignup = action(async (formData: FormData) => {
  "use server"
  await subscribeToNewsletter(
    Resource.OPENSEND_API_KEY.value,
    formData.get("email") as string,
    "opencode.ai newsletter signup",
  )
  return true
})

export function EmailSignup() {
  const submission = useSubmission(emailSignup)
  const i18n = useI18n()
  return (
    <section data-component="email">
      <div data-slot="section-title">
        <h3>{i18n.t("email.title")}</h3>
        <p>{i18n.t("email.subtitle")}</p>
      </div>
      <form data-slot="form" action={emailSignup} method="post">
        <input type="email" name="email" placeholder={i18n.t("email.placeholder")} required />
        <button type="submit" disabled={submission.pending}>
          {i18n.t("email.subscribe")}
        </button>
      </form>
      <Show when={submission.result}>
        <div style="color: #03B000; margin-top: 24px;">{i18n.t("email.success")}</div>
      </Show>
      <Show when={submission.error}>
        <div style="color: #FF408F; margin-top: 24px;">{submission.error}</div>
      </Show>
    </section>
  )
}

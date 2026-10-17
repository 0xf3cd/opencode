import { sendEmail } from "~/lib/aws"
import { Resource } from "@opencode/console-resource"
import { i18n } from "~/i18n"
import { localeFromRequest } from "~/lib/language"
import { createLead } from "~/lib/salesforce"
import { inferenceSpendOptions } from "~/lib/inference-spend"
import { lookupConsoleAccount, type ConsoleAccount } from "~/lib/console-account"
import { addEnterpriseContact } from "~/lib/opensend"

interface EnterpriseFormData {
  name: string
  role: string
  company?: string
  email: string
  phone?: string
  inferenceSpend?: string
  alias?: string
  message: string
}

export async function handleEnterpriseRequest(
  request: Request,
  options: {
    salesforceSubmit?: (payload: Record<string, unknown>) => Promise<boolean>
    notifications?: boolean
    accountLookup?: (email: string) => Promise<ConsoleAccount | null>
  } = {},
) {
  const dict = i18n(localeFromRequest(request))
  try {
    const body = (await request.json()) as EnterpriseFormData
    const trap = typeof body.alias === "string" ? body.alias.trim() : ""

    if (trap) {
      return Response.json({ success: true, message: dict["enterprise.form.success.submitted"] }, { status: 200 })
    }

    if (!body.name || !body.role || !body.email || !body.message) {
      return Response.json({ error: dict["enterprise.form.error.allFieldsRequired"] }, { status: 400 })
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(body.email)) {
      return Response.json({ error: dict["enterprise.form.error.invalidEmailFormat"] }, { status: 400 })
    }

    const inferenceSpend = inferenceSpendOptions.find((option) => option.value === body.inferenceSpend)
    if (body.inferenceSpend && !inferenceSpend) {
      return Response.json({ error: dict["enterprise.form.error.invalidInferenceSpend"] }, { status: 400 })
    }

    const account = await (options.accountLookup ?? lookupConsoleAccount)(body.email).catch((err) => {
      console.error("Failed to look up Console account:", err)
      return undefined
    })

    const emailContent = `
${body.message}<br><br>
${inferenceSpend ? `Current monthly inference spend: ${inferenceSpend.salesforceValue}<br><br>` : ""}
--<br>
${body.name}<br>
${body.role}<br>
${body.company ? `${body.company}<br>` : ""}${body.email}<br>
${body.phone ? `${body.phone}<br>` : ""}`.trim()

    const [lead, mail, contact] = await Promise.all([
      createLead(
        {
          name: body.name,
          role: body.role,
          company: body.company,
          email: body.email,
          phone: body.phone,
          inferenceSpend: inferenceSpend?.salesforceValue,
          message: body.message,
          consoleAccount: account,
        },
        options.salesforceSubmit,
      ).catch((err) => {
        console.error("Failed to create Salesforce lead:", err)
        return false
      }),
      options.notifications === false
        ? Promise.resolve(false)
        : sendEmail({
            to: Resource.ENTERPRISE_SALES_INBOX_EMAIL.value,
            subject: `Enterprise Inquiry from ${body.name}`,
            body: emailContent,
            replyTo: body.email,
          }).then(
            () => true,
            (err) => {
              console.error("Failed to send enterprise email:", err)
              return false
            },
          ),
      options.notifications === false
        ? Promise.resolve(false)
        : addEnterpriseContact(Resource.OPENSEND_API_KEY.value, body.email, body.name).catch((err) => {
            console.error("Failed to add enterprise contact to OpenSend:", err)
            return false
          }),
    ])

    if (!lead && !mail && !contact) {
      if (import.meta.env.DEV) {
        console.warn("Enterprise inquiry accepted in dev mode without integrations", { email: body.email })
        return Response.json({ success: true, message: dict["enterprise.form.success.submitted"] }, { status: 200 })
      }
      console.error("Enterprise inquiry delivery failed", { email: body.email })
      return Response.json({ error: dict["enterprise.form.error.internalServer"] }, { status: 500 })
    }

    return Response.json({ success: true, message: dict["enterprise.form.success.submitted"] }, { status: 200 })
  } catch (error) {
    console.error("Error processing enterprise form:", error)
    return Response.json({ error: dict["enterprise.form.error.internalServer"] }, { status: 500 })
  }
}

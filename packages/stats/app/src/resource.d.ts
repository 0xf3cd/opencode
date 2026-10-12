import "sst/resource"

declare module "sst/resource" {
  export interface Resource {
    OPENSEND_API_KEY: {
      type: "sst.sst.Secret"
      value: string
    }
  }
}

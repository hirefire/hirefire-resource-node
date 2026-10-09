import { middleware as hirefire } from "hirefire-resource/middleware/next"

export const config = { runtime: "nodejs" }

export function middleware(request) {
  return hirefire(request)
}

export function proxy(request) {
  return hirefire(request)
}

export type NextMiddleware = (request: any, event?: any) => any
export function middleware(nextRequest: any): any
export function withHireFire(userMiddleware: NextMiddleware): NextMiddleware

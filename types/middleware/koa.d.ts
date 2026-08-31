export = HireFireMiddlewareKoa
declare function HireFireMiddlewareKoa(
  ctx: any,
  next: () => Promise<void>,
): Promise<void>

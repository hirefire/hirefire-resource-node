export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const hirefire = (await import("hirefire-resource")).default
    hirefire.configure(() => {})
  }
}

import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";

export interface BasicAuthOptions {
  username: string;
  password: string;
  realm?: string;
}

function safeEqual(actual: string, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(actual), digest(expected));
}

/** Validate an HTTP Basic Authorization header without leaking credential length/timing. */
export function validateBasicAuth(header: string | undefined, username: string, password: string): boolean {
  if (!header?.startsWith("Basic ")) return false;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return false;
    const actualUsername = decoded.slice(0, separator);
    const actualPassword = decoded.slice(separator + 1);
    return safeEqual(actualUsername, username) && safeEqual(actualPassword, password);
  } catch {
    return false;
  }
}

/** Protect the dashboard, static assets, and tRPC API with browser-native Basic Auth. */
export function createBasicAuthMiddleware(options: BasicAuthOptions): RequestHandler {
  const realm = options.realm ?? "Feed Watch";
  return (req: Request, res: Response, next: NextFunction) => {
    if (validateBasicAuth(req.header("authorization"), options.username, options.password)) {
      next();
      return;
    }
    res.setHeader("WWW-Authenticate", `Basic realm="${realm}", charset="UTF-8"`);
    res.status(401).send("Authentication required.");
  };
}

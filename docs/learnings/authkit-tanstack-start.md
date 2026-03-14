# AuthKit TanStack Start Learnings

Tactical knowledge from completed tasks. Read by agents before working in this repo.

<!-- Retrospective agent appends entries below. Do not edit existing entries. -->

- **2026-03-12** — `src/client/AuthKitProvider.tsx`: `AuthKitProvider` renders as a Wrap component before `RouterProvider` context exists, so router hooks (`useNavigate`, `useRouter`) cannot be called unconditionally. Use `window.location.href` for navigation that occurs outside router context (e.g., post-sign-out redirect). (from task authkit-tanstack-start-1-issue-57)

declare module '*.md' {
  const content: string;
  export default content;
}

declare module '*.yml' {
  const content: string;
  export default content;
}

declare module '*.yaml' {
  const content: string;
  export default content;
}

declare module '*/apply-seccomp' {
  const path: string;
  export default path;
}

declare module "uuid4" {
  const uuid4: () => string;
  export default uuid4;
}

declare module "pem" {
  const pem: {
    createCertificate: (
      options: Record<string, unknown>,
      callback: (
        error: Error | null,
        result: { serviceKey: string; certificate: string },
      ) => void,
    ) => void;
  };
  export default pem;
}

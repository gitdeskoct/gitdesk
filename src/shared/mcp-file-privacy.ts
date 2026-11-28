const SECRET_FILE =
  /(^|\/)(\.env(\..*)?|\.envrc|\.npmrc|\.netrc|\.pypirc|\.pgpass|\.git-credentials|\.htpasswd|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|p12|pfx|jks|keystore|tfstate|tfstate\.backup|tfvars|kdbx|ovpn)|credentials(\..*)?|secrets?\.(json|ya?ml|toml|env)|kubeconfig(\..*)?|\.kube\/config|\.docker\/config\.json|\.aws\/config|service[-_]account.*\.json)$/is;

export const looksSecret = (path: string) => SECRET_FILE.test(path);
export const CREDENTIAL_FILE_MESSAGE =
  'That file looks like it holds credentials, so gitdesk does not hand it to agents.';

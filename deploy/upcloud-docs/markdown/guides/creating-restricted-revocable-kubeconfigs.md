# Creating Restricted and Revocable Kubeconfigs

## Introduction

Sharing your primary kubeconfig is the security equivalent of giving a stranger the master keys to your house. If you need to grant access to a collaborator or a CI/CD tool, the [standard practice](https://kubernetes.io/docs/concepts/security/service-accounts/#how-to-use) is to create a Service Account and define its boundaries using RBAC (Role-Based Access Control).

This approach ensures that:

- Users only see what they need.
- Deleting the Service Account or its token immediately kills the access without affecting your own kubeconfig.
- You can ensure the user never touches sensitive areas like kube-system.

## Read-Only Access

To give a user "look but don't touch" access, we use the built-in view ClusterRole. This allows them to see pods, logs, and configurations without the ability to modify anything.

1. Create the Identity:

```
kubectl create serviceaccount read-only-user -n default
```

2. Bind the Permissions:
   We use a RoleBinding to restrict the "view" permission to the default namespace only.

```
kubectl create rolebinding test-user-view \\
  --clusterrole=view \\
  --serviceaccount=default:read-only-user \\
  --namespace=default
```

### Generating the kubeconfig for the read-only user.

Regardless of the permission level of the user, the process to generate the file is the same.

1. Variables.

```
SA_NAME="read-only-user"  # <- Change the name here!
NAMESPACE="default"
```

2. Generate a short-lived (1 hour) token.

```
TOKEN=$(kubectl create token ${SA_NAME} -n ${NAMESPACE})
```

3. Extract and set Cluster Details variables.

```
CLUSTER_NAME=$(kubectl config view --minify -o jsonpath='{.clusters[0].name}')
SERVER=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')
CA_DATA=$(kubectl config view --minify --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')
```

4. Generate the file.

```
cat <<EOF > read-only-user.kubeconfig
apiVersion: v1
kind: Config
clusters:
- name: ${CLUSTER_NAME}
  cluster:
    certificate-authority-data: ${CA_DATA}
    server: ${SERVER}
contexts:
- name: restricted-context
  context:
    cluster: ${CLUSTER_NAME}
    namespace: ${NAMESPACE}
    user: ${SA_NAME}
current-context: restricted-context
users:
- name: ${SA_NAME}
  user:
    token: ${TOKEN}
EOF
```

### Test: Read-Only User

This user should be able to see the state of the cluster but never modify it.

**Verify Read:**

```
kubectl get pods --kubeconfig=read-only-user.kubeconfig
```

**Verify Restriction (Create):**

```
# This should FAIL
kubectl run test-nginx --image=nginx --kubeconfig=read-only-user.kubeconfig
```

## Read + Edit without Delete

Sometimes you want a developer to be able to update deployments or restart pods, but you want to prevent accidental (or intentional) deletion of resources. For this, we must create a Custom Role.

1. Create the Identity:

```
kubectl create serviceaccount limited-editor -n default
```

2. Create the Custom Role:

```
## custom-edit-role.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: default
  name: edit-no-delete
rules:
- apiGroups: ["", "apps", "batch"]
  resources: ["pods", "deployments", "services", "jobs", "configmaps"]
  verbs: ["get", "list", "watch", "create", "update", "patch"]
```

**Note**: "delete" and "deletecollection" are intentionally omitted.

3. Bind the Permissions:

```
kubectl apply -f custom-edit-role.yaml

kubectl create rolebinding limited-editor-binding \\
  --role=edit-no-delete \\
  --serviceaccount=default:limited-editor \\
  --namespace=default
```

### Generating the kubeconfig for the limited editor user.

Regardless of the permission level of the user, the process to generate the file is the same.

1. Variables.

```
SA_NAME="limited-editor"  # <- Change the name here!
NAMESPACE="default"
```

2. Generate a short-lived (1 hour) token.

```
TOKEN=$(kubectl create token ${SA_NAME} -n ${NAMESPACE})
```

3. Extract and set Cluster Details variables.

```
CLUSTER_NAME=$(kubectl config view --minify -o jsonpath='{.clusters[0].name}')
SERVER=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')
CA_DATA=$(kubectl config view --minify --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')
```

4. Generate the file.

```
cat <<EOF > limited-editor.kubeconfig
apiVersion: v1
kind: Config
clusters:
- name: ${CLUSTER_NAME}
  cluster:
    certificate-authority-data: ${CA_DATA}
    server: ${SERVER}
contexts:
- name: restricted-context
  context:
    cluster: ${CLUSTER_NAME}
    namespace: ${NAMESPACE}
    user: ${SA_NAME}
current-context: restricted-context
users:
- name: ${SA_NAME}
  user:
    token: ${TOKEN}
EOF
```

### Test: Limited Editor (No Delete)

This is the most critical to test. They should be able to deploy and update, but the delete command must return a Forbidden error.

**Verify Create:**

```
kubectl run editor-test --image=nginx --kubeconfig=limited-editor.kubeconfig
```

**Verify Edit/Patch:**

```
kubectl label pod editor-test status=tested --kubeconfig=limited-editor.kubeconfig
```

**Verify Restriction (Delete):**

```
# This should FAIL
kubectl delete pod editor-test --kubeconfig=limited-editor.kubeconfig
```

## Full Access

If the user needs full administrative control within a specific namespace (the ability to create, edit, and delete everything), we use the built-in edit or admin ClusterRole. By using a RoleBinding, they remain "trapped" in the namespace you choose.

1. Create the Identity:

```
kubectl create serviceaccount namespace-admin -n default
```

2. Bind the Permissions:

```
kubectl create rolebinding test-user-admin-binding \\
  --clusterrole=edit \\
  --serviceaccount=default:namespace-admin \\
  --namespace=default
```

### Generating the kubeconfig for the restricted namespace admin user.

Regardless of the permission level of the user, the process to generate the file is the same.

1. Variables.

```
SA_NAME="namespace-admin"  # <- Change the name here!
NAMESPACE="default"
```

2. Generate a short-lived (1 hour) token.

```
TOKEN=$(kubectl create token ${SA_NAME} -n ${NAMESPACE})
```

3. Extract and set Cluster Details variables.

```
CLUSTER_NAME=$(kubectl config view --minify -o jsonpath='{.clusters[0].name}')
SERVER=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')
CA_DATA=$(kubectl config view --minify --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')
```

4. Generate the file.

```
cat <<EOF > namespace-admin.kubeconfig
apiVersion: v1
kind: Config
clusters:
- name: ${CLUSTER_NAME}
  cluster:
    certificate-authority-data: ${CA_DATA}
    server: ${SERVER}
contexts:
- name: restricted-context
  context:
    cluster: ${CLUSTER_NAME}
    namespace: ${NAMESPACE}
    user: ${SA_NAME}
current-context: restricted-context
users:
- name: ${SA_NAME}
  user:
    token: ${TOKEN}
EOF
```

### Test: Namespace Admin

This user has full power, but only within the walls of the default namespace.

**Verify Full Power:**

```
kubectl delete pod editor-test --kubeconfig=namespace-admin.kubeconfig
```

**Verify Namespace Isolation:**

Try to look into the kube-system namespace. This is the ultimate test of your boundary.

```
# This MUST FAIL for all three users
kubectl get pods -n kube-system --kubeconfig=namespace-admin.kubeconfig
```

## Revocation

To instantly revoke access and render the relevant kubeconfig useless:

```
kubectl delete sa <SA_NAME> -n <NAMESPACE>
```

To ensure your RBAC policies are working correctly, you should run a battery of tests against each generated file. The `--kubeconfig` flag allows you to masquerade as that specific user without changing your main context.

If you don't want to actually run commands and risk creating "garbage" resources, Kubernetes has a built-in tool to check permissions:

```
#Can I delete deployments as the limited-editor? Output will be "no"
kubectl auth can-i delete deployments --kubeconfig={SA_NAME}.kubeconfig
```

**Note:** Replace `{SA_NAME}.kubeconfig` with the name of your user’s kubeconfig.

### Expected Results

| User | get pods | run pod | delete pod | kube-system access |
| --- | --- | --- | --- | --- |
| read-only |  |  |  |  |
| limited-editor |  |  |  |  |
| namespace-admin |  |  |  |  |

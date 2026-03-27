# Get started with the UpCloud Ansible Inventory Collection

## Installation

1. Install UpCloud API's Python bindings:

   ```
   pip3 install upcloud-api>=2.5.0
   ```
2. Install the UpCloud Ansible Collection:

   ```
   ansible-galaxy collection install upcloud.cloud
   ```

## Getting Started

1. Create an `upcloud.yml` inventory file:

   ```
   plugin: upcloud.cloud.servers
   ```
2. Set API credentials by using `upctl account login` command or with environment variables:

   ```
   # Use API token...
   export UPCLOUD_TOKEN="ucat_..."

   # ...or username and password
   export UPCLOUD_USERNAME="your-username"
   export UPCLOUD_PASSWORD="your-password"
   ```
3. View inventory:

   ```
   ansible-inventory -i upcloud.yml --graph --vars
   ```

## Further examples

You can filter resources based on multiple criterias:

```
plugin: upcloud.cloud.servers
zones:
  - fi-hel2
labels:
  - role=prod
  - foo
states:
  - started
connect_with: private_ipv4
network: 035a0a8a-7704-4da5-820d-129fc8232714
server_group: Group name or UUID
```

## Next steps

Check out how to use the Ansible Collection in tandem with UpCloud's Terraform Provider to do [a rolling update on a group of target servers](/docs/guides/rolling-update-terraform-ansible.md).

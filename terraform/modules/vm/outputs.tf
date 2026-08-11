output "vm_id" {
  value = proxmox_virtual_environment_vm.this.vm_id
}

output "name" {
  value = proxmox_virtual_environment_vm.this.name
}

output "node_name" {
  value = proxmox_virtual_environment_vm.this.node_name
}

output "mac_address" {
  value = try(proxmox_virtual_environment_vm.this.network_device[0].mac_address, null)
}

output "ipv4_addresses" {
  description = "Addresses reported by the guest agent (empty when the agent is disabled)"
  value       = proxmox_virtual_environment_vm.this.ipv4_addresses
}

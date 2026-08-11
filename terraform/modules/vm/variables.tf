variable "name" {
  description = "VM name (also the cloud-init hostname)"
  type        = string
}

variable "node_name" {
  type = string
}

variable "vm_id" {
  description = "VM ID. 0 lets Proxmox pick the next free one."
  type        = number
  default     = 0
}

########################################
# Source image: either a cloud image file or an existing template to clone
########################################

variable "cloud_image_file_id" {
  description = "Volume id of a cloud image to import, e.g. local:iso/debian-13-generic-amd64.img. Mutually exclusive with clone_vm_id."
  type        = string
  default     = null
}

variable "clone_vm_id" {
  description = "Existing template/VM id to clone from. Mutually exclusive with cloud_image_file_id."
  type        = number
  default     = null
}

variable "clone_full" {
  type    = bool
  default = true
}

########################################
# Hardware
########################################

variable "cores" {
  type    = number
  default = 2
}

variable "sockets" {
  type    = number
  default = 1
}

variable "cpu_type" {
  description = "Use 'host' for best performance, 'x86-64-v2-AES' if you need live migration between different CPUs"
  type        = string
  default     = "x86-64-v2-AES"
}

variable "memory" {
  description = "RAM in MiB"
  type        = number
  default     = 2048
}

variable "memory_floating" {
  description = "Minimum RAM in MiB for ballooning. 0 disables ballooning."
  type        = number
  default     = 0
}

variable "disk_size" {
  description = "Root disk size in GiB"
  type        = number
  default     = 20
}

variable "datastore_id" {
  type    = string
  default = "local"
}

variable "disk_interface" {
  type    = string
  default = "virtio0"
}

variable "disk_ssd" {
  description = "Advertise the disk as SSD (ignored on virtio-blk)"
  type        = bool
  default     = false
}

variable "disk_discard" {
  type    = string
  default = "on"
}

variable "extra_disks" {
  description = "Additional data disks"
  type = list(object({
    interface    = string
    size         = number
    datastore_id = optional(string)
    ssd          = optional(bool, false)
    discard      = optional(string, "on")
  }))
  default = []
}

variable "bios" {
  description = "seabios or ovmf"
  type        = string
  default     = "seabios"
}

variable "machine" {
  type    = string
  default = null
}

variable "bridge" {
  type    = string
  default = "vmbr1"
}

variable "mtu" {
  type    = number
  default = 0
}

variable "vlan_id" {
  type    = number
  default = null
}

variable "network_model" {
  type    = string
  default = "virtio"
}

########################################
# Cloud-init
########################################

variable "ipv4_address" {
  description = "CIDR address (10.98.3.50/24) or \"dhcp\""
  type        = string
  default     = "dhcp"
}

variable "ipv4_gateway" {
  type    = string
  default = null
}

variable "dns_servers" {
  type    = list(string)
  default = []
}

variable "dns_domain" {
  type    = string
  default = null
}

variable "ci_user" {
  description = "Cloud-init user created on first boot"
  type        = string
  default     = "debian"
}

variable "ci_password" {
  type      = string
  default   = null
  sensitive = true
}

variable "ssh_public_keys" {
  type    = list(string)
  default = []
}

variable "user_data_file_id" {
  description = "Optional snippet volume id for a full cloud-init user-data file, e.g. storage1:snippets/foo.yaml"
  type        = string
  default     = null
}

########################################
# Behaviour
########################################

variable "agent_enabled" {
  description = "Expect qemu-guest-agent inside the VM. Terraform waits for it when true."
  type        = bool
  default     = true
}

variable "started" {
  type    = bool
  default = true
}

variable "start_on_boot" {
  type    = bool
  default = true
}

variable "protection" {
  type    = bool
  default = false
}

variable "stop_on_destroy" {
  description = "Hard-stop instead of graceful shutdown on destroy (faster, needed if the guest ignores ACPI)"
  type        = bool
  default     = true
}

variable "template" {
  description = "Create the VM as a template instead of a runnable guest"
  type        = bool
  default     = false
}

variable "tags" {
  type    = list(string)
  default = ["terraform"]
}

variable "description" {
  type    = string
  default = "Managed by Terraform"
}

variable "pool_id" {
  type    = string
  default = null
}

variable "migrate" {
  description = <<-EOT
    Migrate the VM when node_name changes instead of destroying and recreating
    it. Only supported for QEMU VMs; the provider has no container equivalent.
  EOT
  type    = bool
  default = true
}

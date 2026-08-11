terraform {
  required_providers {
    proxmox = {
      source  = "bpg/proxmox"
      version = ">= 0.111"
    }
  }
}

locals {
  use_cloud_image = var.cloud_image_file_id != null
  use_clone       = var.clone_vm_id != null
}

resource "proxmox_virtual_environment_vm" "this" {
  name        = var.name
  node_name   = var.node_name
  vm_id       = var.vm_id != 0 ? var.vm_id : null
  description = var.description
  tags        = var.tags
  pool_id     = var.pool_id

  started         = var.template ? false : var.started
  on_boot         = var.start_on_boot
  protection      = var.protection
  stop_on_destroy = var.stop_on_destroy
  template        = var.template

  # Without this, changing node_name destroys the VM and builds a new one on the
  # target. With it the provider issues a real PVE migration and the disk comes
  # along. There is no container equivalent — the portal migrates LXCs through
  # the PVE API and then re-imports them into state.
  migrate = var.migrate

  bios    = var.bios
  machine = var.machine

  dynamic "clone" {
    for_each = local.use_clone ? [1] : []
    content {
      vm_id = var.clone_vm_id
      full  = var.clone_full
    }
  }

  agent {
    enabled = var.agent_enabled
  }

  cpu {
    cores   = var.cores
    sockets = var.sockets
    type    = var.cpu_type
  }

  memory {
    dedicated = var.memory
    floating  = var.memory_floating
  }

  # Root disk. With a cloud image the qcow2 is imported into the datastore;
  # with a clone the disk already exists and this block only resizes it.
  disk {
    datastore_id = var.datastore_id
    interface    = var.disk_interface
    size         = var.disk_size
    ssd          = var.disk_ssd
    discard      = var.disk_discard
    import_from  = local.use_cloud_image ? var.cloud_image_file_id : null
    file_format  = local.use_cloud_image ? "raw" : null
  }

  dynamic "disk" {
    for_each = { for d in var.extra_disks : d.interface => d }
    content {
      datastore_id = coalesce(disk.value.datastore_id, var.datastore_id)
      interface    = disk.value.interface
      size         = disk.value.size
      ssd          = disk.value.ssd
      discard      = disk.value.discard
    }
  }

  network_device {
    bridge  = var.bridge
    model   = var.network_model
    mtu     = var.mtu
    vlan_id = var.vlan_id
  }

  initialization {
    datastore_id = var.datastore_id
    interface    = "ide2"

    ip_config {
      ipv4 {
        address = var.ipv4_address
        gateway = var.ipv4_address == "dhcp" ? null : var.ipv4_gateway
      }
    }

    dynamic "dns" {
      for_each = length(var.dns_servers) > 0 || var.dns_domain != null ? [1] : []
      content {
        domain  = var.dns_domain
        servers = var.dns_servers
      }
    }

    # user_account and user_data_file_id are mutually exclusive in cloud-init:
    # a custom user-data snippet fully replaces the generated one.
    dynamic "user_account" {
      for_each = var.user_data_file_id == null ? [1] : []
      content {
        username = var.ci_user
        password = var.ci_password
        keys     = var.ssh_public_keys
      }
    }

    user_data_file_id = var.user_data_file_id
  }

  serial_device {} # cloud images expect a serial console

  operating_system {
    type = "l26"
  }

  lifecycle {
    ignore_changes = [
      disk[0].import_from, # only meaningful at create time
      # Cloud-init credentials cannot be read back from Proxmox, so a VM that
      # enters state via `terraform import` would otherwise look like it needs
      # replacing. See the same note in modules/lxc/main.tf.
      initialization[0].user_account,
    ]
  }
}

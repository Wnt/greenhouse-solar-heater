# Recommended software for GPU Servers

To get the most out of your GPU Server on UpCloud, we recommend starting with the AI/ML-ready GPU Ubuntu template. This template comes pre-configured with many of the tools and drivers required for GPU workloads, saving you setup time and ensuring compatibility.

However, you are free to use any public template operating system available on UpCloud, or even upload and deploy your own custom images. Regardless of your OS choice, you will need to install the appropriate NVIDIA® drivers to enable GPU functionality.

## Operating system options

- **AI/ML-ready GPU Ubuntu template:** Pre-installed with common GPU drivers and libraries for machine learning and data science.
- **Other public templates:** Choose from a variety of Linux distributions or Windows Server images.
- **Custom images:** Upload your own OS image if you have specific requirements.

## Essential software to install

For a basic and functional GPU environment, we recommend installing the following:

- **NVIDIA GPU drivers:** Required for the operating system to recognize and utilize the GPU hardware. See [NVIDIA Driver Downloads](https://www.nvidia.com/Download/index.aspx).
- **CUDA drivers:** Enable GPU acceleration for compute workloads. See [CUDA Toolkit and Drivers](https://developer.nvidia.com/cuda-downloads).
- **CUDA Toolkit:** Provides libraries, compiler, and tools for developing GPU-accelerated applications.
- **NVIDIA Container Toolkit:** Enables GPU access inside Docker containers, allowing you to run GPU-accelerated applications in containers. See [Installing the NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.md).
- **Docker Community Edition:** Open-source platform for running applications in containers, useful for managing and deploying GPU workloads. See [Install Docker Engine](https://docs.docker.com/engine/install/).
- **Popular ML/AI frameworks:** Such as [TensorFlow](https://www.tensorflow.org/install) or [PyTorch](https://pytorch.org/get-started/locally/), depending on your workload.

Always refer to the official NVIDIA documentation for the latest installation steps and compatibility notes.

## Additional Recommendations

- Keep your drivers and toolkits up to date for best performance and security.
- Test your GPU installation with `nvidia-smi` to verify that the GPU is recognized and drivers are loaded.
- For advanced workloads, consider installing Docker and NVIDIA Container Toolkit for containerized GPU workloads.

NVIDIA is a registered trademark of NVIDIA Corporation.

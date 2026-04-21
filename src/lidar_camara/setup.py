import os
from glob import glob
from setuptools import find_packages, setup

package_name = 'lidar_camara'

setup(
    name=package_name,
    version='0.1.0',
    packages=find_packages(exclude=['test']),
    data_files=[
        ('share/ament_index/resource_index/packages', ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
        (os.path.join('share', package_name, 'config'), glob('config/*.yaml')),
        (os.path.join('share', package_name, 'launch'), glob('launch/*.py')),
    ],
    install_requires=['setuptools'],
    zip_safe=True,
    maintainer='franco',
    maintainer_email='francolopez0052@gmail.com',
    description='Fusión LiDAR + cámara YOLO para SALUS',
    license='Apache-2.0',
    tests_require=['pytest'],
    entry_points={
        'console_scripts': [
            'fusion_node = lidar_camara.fusion_node:main',
            'vision_brake_guard = lidar_camara.vision_brake_guard:main',
            'obstacle_recovery = lidar_camara.obstacle_recovery_node:main',
            'lidar_brake_guard = lidar_camara.lidar_brake_guard:main',
        ],
    },
)
